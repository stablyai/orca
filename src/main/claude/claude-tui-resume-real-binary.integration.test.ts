import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { resolveClaudeCommand } from '../codex-cli/command'
import { readStructuredTuiProcessIdentity } from '../runtime/structured-tui-process-identity'
import { getSpawnArgsForWindows } from '../win32-utils'
import { CLAUDE_STRUCTURED_BASE_ARGS } from './claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import { createClaudeTuiResumeLaunchBuilder } from './claude-tui-resume-launch'
import { proveClaudeTuiResume } from './claude-tui-resume-proof'

const command = resolveClaudeCommand()
const claudeAvailable =
  spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 5_000 }).status === 0
const roots: string[] = []
const transcripts: string[] = []

function shellQuote(value: string): string {
  return process.platform === 'win32'
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'"'"'`)}'`
}

async function installCaptureHook(
  root: string
): Promise<{ eventsPath: string; settingsPath: string }> {
  const scriptPath = join(root, 'capture-session-start.cjs')
  const eventsPath = join(root, 'session-start.jsonl')
  const settingsPath = join(root, 'settings.json')
  await writeFile(
    scriptPath,
    [
      "const { appendFileSync } = require('node:fs')",
      "let input = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => { input += chunk })",
      "process.stdin.on('end', () => {",
      '  const payload = JSON.parse(input)',
      '  payload.launchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN',
      '  appendFileSync(process.argv[2], `${JSON.stringify(payload)}\\n`)',
      '})',
      ''
    ].join('\n')
  )
  await writeFile(
    settingsPath,
    JSON.stringify({
      theme: 'dark',
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: [process.execPath, scriptPath, eventsPath].map(shellQuote).join(' ')
              }
            ]
          }
        ]
      }
    })
  )
  return { eventsPath, settingsPath }
}

async function waitForHook(
  eventsPath: string,
  source: 'startup' | 'resume'
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const contents = await readFile(eventsPath, 'utf8').catch(() => '')
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) {
        continue
      }
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.hook_event_name === 'SessionStart' && event.source === source) {
        return event
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Claude did not emit a ${source} SessionStart hook`)
}

type RunningTui = { proc: pty.IPty; exited: Promise<void> }

function spawnResumeTui(args: string[], env: Record<string, string>): RunningTui {
  const direct = process.platform === 'win32'
  const proc = pty.spawn(
    direct ? command : process.env.SHELL || '/bin/zsh',
    direct ? args : ['-l'],
    {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: { ...env, TERM: 'xterm-256color' }
    }
  )
  if (!direct) {
    setTimeout(() => {
      proc.write(`${[command, ...args].map(shellQuote).join(' ')}\r`)
    }, 100).unref()
  }
  return { proc, exited: new Promise<void>((resolve) => proc.onExit(() => resolve())) }
}

function structuredIdentity(providerSessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId: 'orca-real-claude-resume',
    workspaceId: 'workspace-real',
    hostId: 'local',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: providerSessionId, leafUuid: null }
  }
}

async function waitForStructuredResult(events: ClaudeStructuredSessionEvent[]): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === 'message' && event.message.type === 'result')) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Claude structured session did not finish its product-path turn')
}

async function stopTui(tui: RunningTui): Promise<void> {
  try {
    tui.proc.kill('SIGKILL')
  } catch {
    return
  }
  await Promise.race([
    tui.exited,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Claude TUI did not exit after cleanup')), 5_000)
    )
  ])
}

afterEach(async () => {
  await Promise.all(transcripts.splice(0).map((path) => rm(path, { force: true })))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!claudeAvailable)('real Claude TUI resume proof', () => {
  it('resumes a product-created structured session and proves its exact child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-tui-resume-'))
    roots.push(root)
    const { eventsPath, settingsPath } = await installCaptureHook(root)
    const providerSessionId = randomUUID()
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
    const events: ClaudeStructuredSessionEvent[] = []
    const structuredLaunch = getSpawnArgsForWindows(command, [
      ...CLAUDE_STRUCTURED_BASE_ARGS,
      '--settings',
      settingsPath,
      '--session-id',
      providerSessionId
    ])
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: structuredLaunch.spawnCmd,
        args: structuredLaunch.spawnArgs,
        cwd: process.cwd(),
        claudeConfigDir,
        providerSessionId,
        resumeLeafUuid: null,
        resumed: false
      }),
      onEvent: (event) => events.push(event),
      readProcessStartTime: async () => 1
    })
    let resumed: RunningTui | null = null
    try {
      const acquisition = await adapter.acquire({
        identity: structuredIdentity(providerSessionId),
        fence: 1,
        spawnToken: 'real-create'
      })
      await expect(
        adapter.dispatch({
          sessionId: 'orca-real-claude-resume',
          clientMessageId: 'real-product-turn',
          fence: 1,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Reply only with ORCA_RESUME_READY.' }]
          }
        })
      ).resolves.toMatchObject({ state: 'accepted' })
      await waitForStructuredResult(events)
      const started = await waitForHook(eventsPath, 'startup')
      const transcriptPath = String(started.transcript_path)
      transcripts.push(transcriptPath)
      expect(started.session_id).toBe(providerSessionId)
      await adapter.closeAll()

      const record = {
        sessionId: 'orca-real-claude-resume',
        provider: 'claude',
        location: { workspaceId: 'workspace-real' },
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: claudeConfigDir },
        providerHandleChain: [
          {
            linkId: 'created-real',
            handle: acquisition.link.handle,
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1
          }
        ]
      } as AgentSessionRecord
      const launch = await createClaudeTuiResumeLaunchBuilder({
        resolveWorkspacePath: async () => process.cwd(),
        resolveCommand: () => command
      })({ record, spawnToken: 'real-resume' })
      resumed = spawnResumeTui([...launch.args, '--settings', settingsPath], launch.env)
      let resumedOutput = ''
      resumed.proc.onData((data) => {
        resumedOutput = `${resumedOutput}${data}`.slice(-4_000)
      })

      const [processIdentity, proof] = await Promise.all([
        readStructuredTuiProcessIdentity({
          hostId: 'local',
          rootPid: resumed.proc.pid,
          spawnToken: 'real-resume',
          agent: 'claude'
        }),
        proveClaudeTuiResume({
          expectedSessionId: providerSessionId,
          expectedTranscriptPath: transcriptPath,
          expectedLaunchToken: 'real-resume',
          waitForSessionStart: () => waitForHook(eventsPath, 'resume')
        }).catch((error) => {
          throw new Error(`${String(error)}\nClaude output: ${resumedOutput}`)
        })
      ])
      expect(processIdentity).toMatchObject({
        hostId: 'local',
        spawnToken: 'real-resume',
        pid: expect.any(Number)
      })
      expect(proof).toMatchObject({ sessionId: providerSessionId, transcriptPath })
    } finally {
      await adapter.closeAll()
      if (resumed) {
        await stopTui(resumed)
      }
    }
  }, 30_000)
})
