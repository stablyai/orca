import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makePaneKey } from '../../shared/stable-pane-id'
import { getManagedScript as codexScript } from '../codex/codex-hook-script'
import { AgentHookServer } from './server'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

type CodexHookPayload = { hook_event_name: string; prompt?: string }

let dir: string
let servers: AgentHookServer[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-hook-inbox-server-'))
  servers = []
})

afterEach(() => {
  for (const server of servers) {
    server.stop()
  }
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: dir })
  return server
}

function inboxDir(): string {
  return join(dir, 'agent-hooks', 'hook-inbox')
}

function paneState(server: AgentHookServer): string {
  return server.getStatusSnapshotForPane(PANE)[0]?.state ?? 'missing'
}

/** Runs the real managed Codex hook the way Codex does, with a deadline, while a stand-in curl
 *  hangs as a stalled Orca would. spawnSync also blocks this thread — the hook server's thread —
 *  for the whole run, so the hook cannot rely on Orca answering anything. */
function runCodexHookAgainstStalledOrca(server: AgentHookServer, payload: CodexHookPayload) {
  const bin = mkdtempSync(join(dir, 'bin-'))
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexec sleep 30\n')
  chmodSync(join(bin, 'curl'), 0o755)
  const script = join(bin, 'codex-hook.sh')
  writeFileSync(script, codexScript('posix'))
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ORCA_')) {
      env[key] = value
    }
  }
  return spawnSync('/bin/sh', [script], {
    input: JSON.stringify(payload),
    env: {
      ...env,
      ...server.buildPtyEnv(),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ORCA_PANE_KEY: PANE,
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'wt-1'
    },
    // Why: the deadline Codex applies to Interrupt/SessionEnd hooks, after which it SIGKILLs.
    timeout: 1_000,
    killSignal: 'SIGKILL',
    encoding: 'utf8'
  })
}

function commitRecord(name: string, payload: CodexHookPayload): void {
  writeFileSync(
    join(inboxDir(), name),
    [
      JSON.stringify(payload),
      'orca-hook-record v1',
      'source=codex',
      `paneKey=${PANE}`,
      'tabId=tab-1',
      'worktreeId=wt-1',
      'env=production',
      'orca-hook-end',
      ''
    ].join('\n')
  )
}

// Why: Windows hosts open no inbox until a Windows hook commits to one.
describe.skipIf(process.platform === 'win32')('hook inbox', () => {
  it('advertises the inbox in the endpoint file only once it drains it', async () => {
    const server = await startServer()
    expect(readFileSync(server.endpointFilePath!, 'utf8')).toContain('ORCA_AGENT_HOOK_INBOX=1\n')
  })

  it.skipIf(process.platform === 'win32')(
    'applies an event whose hook the agent killed while Orca could not answer',
    async () => {
      const server = await startServer()

      const run = runCodexHookAgainstStalledOrca(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'ship it'
      })

      // Delivered live, not at the next launch.
      await expect.poll(() => paneState(server), { timeout: 3_000, interval: 10 }).toBe('working')
      expect(readdirSync(inboxDir())).toEqual([])
      // And the hook finished well inside the deadline: it never waited on Orca.
      expect(run.signal).toBeNull()
      expect(run.status).toBe(0)
    }
  )

  it('lets a committed Stop, not a Ctrl+C inferred after it, end the turn', async () => {
    const server = await startServer()
    commitRecord('300.0.rec', { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    await expect.poll(() => paneState(server), { timeout: 3_000, interval: 10 }).toBe('working')
    const [working] = server.getStatusSnapshotForPane(PANE)

    // The turn completed and committed its Stop just before the user's Ctrl+C was judged.
    commitRecord('301.0.rec', { hook_event_name: 'Stop' })
    const inferred = server.inferInterrupt({
      paneKey: PANE,
      baselineUpdatedAt: working!.receivedAt,
      baselineStateStartedAt: working!.stateStartedAt,
      baselinePrompt: 'ship it',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })

    expect(inferred).toBe(false)
    expect(paneState(server)).toBe('done')
  })

  it('reaps a pane that died while Orca was closed instead of leaving its replay working', async () => {
    const commitClaude = (name: string, payload: Record<string, unknown>) =>
      writeFileSync(
        join(inboxDir(), name),
        [
          JSON.stringify({ session_id: 's1', ...payload }),
          'orca-hook-record v1',
          'source=claude',
          `paneKey=${PANE}`,
          'tabId=tab-1',
          'worktreeId=wt-1',
          'env=production',
          'orca-hook-end',
          ''
        ].join('\n')
      )
    const first = await startServer()
    commitClaude('100.0.rec', { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    await expect.poll(() => paneState(first), { timeout: 3_000, interval: 10 }).toBe('working')
    first.stop()
    // Orca closed: the agent committed one more event, then its PTY died.
    commitClaude('101.0.rec', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' }
    })

    const restarted = await startServer()
    await restarted.reapRestoredClaudeSubagentsWithoutLiveAgent(
      () => true,
      async () => false,
      () => true
    )
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(paneState(restarted)).not.toBe('working')
  })

  it('replays what agents committed while Orca was closed, fenced to the current launch', async () => {
    const first = await startServer()
    first.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        launchToken: 'current-launch',
        payload: { state: 'working', prompt: 'ship it', agentType: 'codex' }
      },
      'inbox-test'
    )
    first.flushStatusPersistSync()
    first.stop()

    mkdirSync(inboxDir(), { recursive: true })
    const stale = (name: string, launchToken: string, payload: CodexHookPayload) =>
      writeFileSync(
        join(inboxDir(), name),
        [
          JSON.stringify(payload),
          'orca-hook-record v1',
          'source=codex',
          `paneKey=${PANE}`,
          'tabId=tab-1',
          `launchToken=${launchToken}`,
          'orca-hook-end',
          ''
        ].join('\n')
      )
    const at = Date.now() / 1000
    stale('1.0.rec', 'current-launch', { hook_event_name: 'Stop' })
    utimesSync(join(inboxDir(), '1.0.rec'), at - 2, at - 2)
    // Committed last by a process from a launch this pane has since replaced: must not apply.
    stale('2.0.rec', 'previous-launch', { hook_event_name: 'UserPromptSubmit', prompt: 'old' })
    utimesSync(join(inboxDir(), '2.0.rec'), at - 1, at - 1)

    const restarted = await startServer()
    // Replayed in background slices, off the startup path the listener binds on.
    await expect.poll(() => readdirSync(inboxDir()), { timeout: 3_000, interval: 10 }).toEqual([])
    expect(paneState(restarted)).toBe('done')
  })
})
