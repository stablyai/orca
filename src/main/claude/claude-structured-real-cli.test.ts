import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { resolveClaudeCommand } from '../codex-cli/command'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { getSpawnArgsForWindows } from '../win32-utils'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'

const command = resolveClaudeCommand()
const versionLaunch = getSpawnArgsForWindows(command, ['--version'])
const realClaudeAvailable =
  spawnSync(versionLaunch.spawnCmd, versionLaunch.spawnArgs, {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 5_000
  }).status === 0
const authStatusLaunch = getSpawnArgsForWindows(command, ['auth', 'status', '--json'])
/** The CLI's own account report — the only source of truth for where it writes that
 *  is not derived from Orca's own path expressions. */
const realClaudeAuthStatus = (() => {
  if (!realClaudeAvailable) {
    return null
  }
  const result = spawnSync(authStatusLaunch.spawnCmd, authStatusLaunch.spawnArgs, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000
  })
  if (result.status !== 0) {
    return null
  }
  try {
    return JSON.parse(result.stdout) as { loggedIn?: boolean; projectsDirectory?: string }
  } catch {
    return null
  }
})()
const realClaudeAuthenticated = realClaudeAuthStatus?.loggedIn === true

function realAdapter(
  providerSessionId: string,
  claudeConfigDir: string,
  events: ClaudeStructuredSessionEvent[] = []
): ClaudeStructuredSessionAdapter {
  return new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: command,
      options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, sessionId: providerSessionId },
      cwd: process.cwd(),
      claudeConfigDir,
      providerSessionId,
      resumeLeafUuid: null,
      resumed: false
    }),
    onEvent: (event) => events.push(event),
    readProcessStartTime: async () => 1,
    now: () => 2,
    initTimeoutMs: 5_000
  })
}

function identity(providerSessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId: 'real-cli-handshake',
    workspaceId: 'real-cli-workspace',
    hostId: 'local',
    agent: 'claude',
    providerHandle: { kind: 'claude', sessionId: providerSessionId, leafUuid: null }
  }
}

/** The CLI flushes its transcript on its own schedule; poll rather than race it. */
async function waitForResolvedTranscript(
  providerSessionId: string,
  timeoutMs = 15_000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // No options: the exact call transcript-read-cache.ts makes for mobile.
    const resolved = await resolveSessionFilePath('claude', providerSessionId)
    if (resolved || Date.now() >= deadline) {
      return resolved
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI handshake', () => {
  it.skipIf(!realClaudeAuthenticated)(
    'proves a pre-minted session before the first user message',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events)

      try {
        const acquisition = await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli'
        })
        const observedSubtypes = events.flatMap((event) =>
          event.type === 'message' ? [event.message.subtype] : []
        )

        expect(acquisition.link.handle).toMatchObject({
          provider: 'claude',
          sessionId: providerSessionId,
          // Init/SessionStart UUIDs are protocol frames, not resumable
          // main-transcript leaves; no cursor exists before the first user turn.
          leafUuid: null
        })
        expect(observedSubtypes).toContain('hook_started')
      } finally {
        await adapter.closeAll()
      }
    },
    10_000
  )

  // Unit tests can only pin the shape we read, which is exactly how the blank
  // Effort pill survived every gate: the fixture invented an `effortLevel` on a
  // frame the CLI does not send. This asserts both halves against the live
  // binary — that get_settings reports the effort, and that init does not.
  it.skipIf(!realClaudeAuthenticated)(
    'reports the current effort through get_settings and never on the init frame',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events)

      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-effort'
        })
        const published = events.flatMap((event) =>
          event.type === 'message' ? [event.message] : []
        )
        const options = await adapter.readOptions({ sessionId: 'real-cli-handshake', fence: 1 })

        expect(published.length).toBeGreaterThan(0)
        // Not just the init frame: no frame the CLI publishes carries an effort
        // at all. Goes red the day one does, which is when the simpler fix
        // becomes available. Which frame proves the session varies by host, so
        // this asserts over all of them rather than picking one.
        expect(published.filter((frame) => 'effortLevel' in frame)).toEqual([])
        // Goes red if `effective.effortLevel` is renamed or dropped, which no
        // fixture-backed test can see.
        expect(options.current.effort).toEqual(expect.any(String))
      } finally {
        await adapter.closeAll()
      }
    },
    15_000
  )

  // Mobile native chat never reads the structured journal — it reads the CLI's own
  // transcript through native-chat/session-file-resolver.ts. So this resolves the way
  // transcript-read-cache.ts:104 does, with NO root override, and checks the answer
  // against the root the CLI itself reports. Deriving the expected root from Orca's own
  // `CLAUDE_CONFIG_DIR || ~/.claude` expression — the same one the code under test uses —
  // would move both sides together and stay green in exactly the environment that
  // blacks mobile out.
  // The turn is what creates the file: an init-only handshake writes nothing.
  it.skipIf(!realClaudeAuthenticated || !realClaudeAuthStatus?.projectsDirectory)(
    'writes its transcript where the mobile session-file resolver looks for it',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const adapter = realAdapter(providerSessionId, claudeConfigDir)
      const cliProjectsDir = realClaudeAuthStatus?.projectsDirectory as string

      let transcriptPath: string | null = null
      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-transcript'
        })
        await adapter.dispatch({
          sessionId: 'real-cli-handshake',
          clientMessageId: 'real-cli-transcript-1',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
          fence: 1
        })
        transcriptPath = await waitForResolvedTranscript(providerSessionId)
      } finally {
        await adapter.closeAll()
      }

      expect(transcriptPath).not.toBeNull()
      expect(basename(transcriptPath ?? '')).toBe(`${providerSessionId}.jsonl`)
      // `<the root the CLI reports>/<project slug>/<provider session id>.jsonl`
      expect(relative(cliProjectsDir, transcriptPath ?? '').split(/[\\/]/)).toHaveLength(2)
      // And the pinned account home is that same root, so the host-side leaf recovery
      // (structured-claude-runtime-adapter.ts:64) and mobile agree.
      expect(join(claudeConfigDir, 'projects')).toBe(cliProjectsDir)
    },
    45_000
  )

  // The model half of the same lesson: a fixture can only pin the shape we read.
  // set_model answers success for a model it never resolves — a nonexistent id is
  // accepted and only fails once a turn runs — so the CLI's own report is the only
  // adoption evidence, and it arrives on the init frame that opens each turn. This
  // asserts that frame carries the resolved model against the live binary; it goes
  // red the day the CLI stops reporting it, which is the day the confirmation
  // silently degrades to echoing back whatever Orca sent.
  it.skipIf(!realClaudeAuthenticated)(
    'reports the model it adopted on the init frame that opens each turn',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events)

      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-model'
        })
        await adapter.setOption({
          sessionId: 'real-cli-handshake',
          key: 'model',
          value: 'haiku',
          fence: 1
        })
        const before = events.length
        await adapter.dispatch({
          sessionId: 'real-cli-handshake',
          clientMessageId: 'real-cli-model-1',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Say ok' }] },
          fence: 1
        })
        const deadline = Date.now() + 60_000
        let frames: Record<string, unknown>[] = []
        for (;;) {
          frames = events
            .slice(before)
            .flatMap((event) =>
              event.type === 'message' &&
              event.message.type === 'system' &&
              event.message.subtype === 'init'
                ? [event.message]
                : []
            )
          if (frames.length > 0 || Date.now() >= deadline) {
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }

        expect(frames).not.toHaveLength(0)
        // Both halves: the field exists, and it names the model the picker asked
        // for in the catalog's resolved shape rather than the id Orca sent.
        expect(frames[0]?.model).toEqual(expect.any(String))
        expect(frames[0]?.model).toBe('claude-haiku-4-5-20251001')
        await expect(
          adapter.readOptions({ sessionId: 'real-cli-handshake', fence: 1 })
        ).resolves.toMatchObject({ current: { model: 'haiku' } })
      } finally {
        await adapter.closeAll()
      }
    },
    90_000
  )

  it('turns a real silent unauthenticated startup into sign-in guidance', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'orca-claude-no-auth-'))
    const providerSessionId = randomUUID()
    const adapter = realAdapter(providerSessionId, claudeConfigDir)

    try {
      await expect(
        adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-no-auth'
        })
      ).rejects.toThrow(/not signed in.*Claude CLI.*CLAUDE_CONFIG_DIR/s)
    } finally {
      await adapter.closeAll()
      await rm(claudeConfigDir, { recursive: true, force: true })
    }
  }, 10_000)
})
