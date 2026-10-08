import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import * as claudeConnection from './claude-stream-json-connection'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'
import { readClaudeInit } from './claude-structured-init-proof'
import {
  realClaudeAuthenticated,
  realClaudeAuthStatus,
  realClaudeAvailable,
  realClaudeCliGate,
  realClaudeCommand,
  realClaudeLaunchHome
} from './claude-real-cli-availability-test-support'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import type { ClaudeStructuredSessionAdapterDeps } from './claude-structured-session-state'
import { claudeStartupSettled } from './claude-structured-session-test-support'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const command = realClaudeCommand
const suiteTitle = `Claude structured real CLI handshake${realClaudeCliGate.skipReason ? ` (skipped: ${realClaudeCliGate.skipReason})` : ''}`

function realAdapter(
  providerSessionId: string,
  claudeConfigDir: string,
  events: ClaudeStructuredSessionEvent[] = [],
  cwd = process.cwd(),
  onDispatchSettledLate?: ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate'],
  env = realClaudeLaunchHome().env,
  waitsForStartup = true
): ClaudeStructuredSessionAdapter {
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: command,
      options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, sessionId: providerSessionId },
      cwd,
      env,
      claudeConfigDir,
      providerSessionId,
      resumeLeafUuid: null,
      resumesTranscript: false,
      continuesChain: false
    }),
    onEvent: (event) => events.push(event),
    ...(onDispatchSettledLate ? { onDispatchSettledLate } : {}),
    readProcessStartTime: async () => 1,
    now: () => 2
  })
  if (!waitsForStartup) {
    return adapter
  }
  // These proofs read startup facts, which land after the session is published.
  const acquire = adapter.acquire
  adapter.acquire = async (input) => {
    const acquisition = await acquire(input)
    await claudeStartupSettled(adapter, input.identity.sessionId)
    return acquisition
  }
  return adapter
}

function identity(providerSessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId: 'real-cli-handshake',
    workspaceId: 'real-cli-workspace',
    hostId: 'local',
    agent: 'claude',
    providerHandle: claudeProviderHandle(providerSessionId, null)
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

describe('real CLI fixture authentication isolation', () => {
  it.each(['authenticated', 'signed-out'] as const)(
    'keeps the %s launch environment independent of inherited credentials',
    async (mode) => {
      const authKeys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const
      for (const key of authKeys) {
        vi.stubEnv(key, 'unusable-fixture-auth-value')
      }
      let childEnv: Record<string, string> | undefined
      const open = vi
        .spyOn(claudeConnection, 'openClaudeStreamJsonConnection')
        .mockImplementation(async (launch) => {
          childEnv = buildClaudeChildProcessEnv(launch.env)
          throw new Error('fixture stopped before spawning a CLI')
        })
      const providerSessionId = randomUUID()
      const adapter = realAdapter(
        providerSessionId,
        join(tmpdir(), 'orca-synthetic-signed-out'),
        [],
        process.cwd(),
        undefined,
        mode === 'signed-out' ? {} : undefined
      )
      try {
        await expect(
          adapter.acquire({
            identity: identity(providerSessionId),
            fence: 1,
            spawnToken: 'fixture'
          })
        ).rejects.toThrow('fixture stopped before spawning a CLI')
        expect(open).toHaveBeenCalledOnce()
        for (const key of authKeys) {
          expect(childEnv?.[key]).toBe(
            mode === 'authenticated' ? 'unusable-fixture-auth-value' : undefined
          )
        }
      } finally {
        await adapter.closeAll()
        open.mockRestore()
        vi.unstubAllEnvs()
      }
    }
  )
})

describe.skipIf(!realClaudeAvailable)(suiteTitle, () => {
  it.skipIf(!realClaudeAuthenticated)(
    'proves a pre-minted session before the first user message',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const events: ClaudeStructuredSessionEvent[] = []
      const cwd = await mkdtemp(join(tmpdir(), 'orca-command-init-'))
      await mkdir(join(cwd, '.claude', 'commands'), { recursive: true })
      await writeFile(
        join(cwd, '.claude', 'commands', 'orca-init-catalog-proof.md'),
        '---\ndescription: Initialization catalog proof\n---\nReply with OK.\n'
      )
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events, cwd)

      try {
        const acquisition = await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli'
        })
        const observedSubtypes = events.flatMap((event) =>
          event.type === 'message' ? [event.message.subtype] : []
        )

        // Init/SessionStart UUIDs are protocol frames, not resumable
        // main-transcript leaves; no cursor exists before the first user turn.
        expect(acquisition.link.handle).toEqual(claudeProviderHandle(providerSessionId, null))
        expect(observedSubtypes).toContain('hook_started')
        expect(adapter.readCommands('real-cli-handshake')).toContainEqual(
          expect.objectContaining({
            name: 'orca-init-catalog-proof',
            kind: 'command',
            kindUnspecified: true
          })
        )
        expect(
          adapter.readCommands('real-cli-handshake')?.some(({ name }) => name === 'help')
        ).toBe(false)
      } finally {
        await adapter.closeAll()
        await rm(cwd, { recursive: true, force: true })
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

  // The contract a chat's first message depends on: saved options ride the launch, and the
  // message is written as soon as the child is published, before the CLI answers initialize.
  it.skipIf(!realClaudeAuthenticated)(
    'runs a message written before initialize answers, under the saved options it was launched with',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = realAdapter(
        providerSessionId,
        claudeConfigDir,
        events,
        process.cwd(),
        undefined,
        realClaudeLaunchHome().env,
        false
      )
      const messages = (): Record<string, unknown>[] =>
        events.flatMap((event) => (event.type === 'message' ? [event.message] : []))

      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-saved-options',
          options: { model: 'sonnet', permissionMode: 'plan', effort: 'low' }
        })
        const dispatched = await adapter.dispatch({
          sessionId: 'real-cli-handshake',
          clientMessageId: 'real-cli-saved-options-1',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Reply with exactly: OK. Do not use any tools.' }]
          },
          fence: 1
        })
        // Read as the write resolves: the CLI had not answered initialize, so nothing held it.
        const answeredAtDispatch = adapter['sessions'].get('real-cli-handshake')?.startup.answered
        const startedAtDispatch = events.some((event) => event.type === 'started')
        expect(dispatched).toEqual({ state: 'admitted' })
        expect(answeredAtDispatch).toBe(false)
        expect(startedAtDispatch).toBe(false)
        const deadline = Date.now() + 90_000
        while (!messages().some((m) => m.type === 'result') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }

        // The echo of the message Orca wrote, then a turn that ended in success.
        expect(messages()).toContainEqual(expect.objectContaining({ type: 'user', isReplay: true }))
        expect(messages().find((m) => m.type === 'result')).toMatchObject({ is_error: false })
        // The turn's own init names what the child was launched with.
        expect(messages().find((m) => m.type === 'system' && m.subtype === 'init')).toMatchObject({
          model: 'claude-sonnet-5',
          permissionMode: 'plan'
        })
      } finally {
        await adapter.closeAll()
      }
    },
    120_000
  )

  // The window a Stop naming no turn exists for: Orca has written the message, and Claude has not
  // started its reply, so no turn id exists. Only the live binary can say the interrupt lands there.
  it.skipIf(!realClaudeAuthenticated)(
    'stops a message interrupted before its reply starts, and takes the next one',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events)
      const frames = (from: number) =>
        events.slice(from).flatMap((event) => (event.type === 'message' ? [event.message] : []))
      const replyStarted = (from: number) =>
        frames(from).some(
          (frame) =>
            frame.type === 'stream_event' &&
            typeof frame.event === 'object' &&
            frame.event !== null &&
            'type' in frame.event &&
            frame.event.type === 'message_start'
        )
      const result = async (from: number) => {
        const deadline = Date.now() + 60_000
        for (;;) {
          const found = frames(from).find((frame) => frame.type === 'result')
          if (found || Date.now() >= deadline) {
            return found
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      const send = (clientMessageId: string, text: string) =>
        adapter.dispatch({
          sessionId: 'real-cli-handshake',
          clientMessageId,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
          fence: 1
        })

      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-stop'
        })
        const first = events.length
        await expect(
          send('real-cli-stop-1', 'Count from 1 to 300, one number per line, and nothing else.')
        ).resolves.toEqual({ state: 'admitted' })
        const startedBeforeStop = replyStarted(first)

        await expect(
          adapter.cancelTurn({ sessionId: 'real-cli-handshake', fence: 1 })
        ).resolves.toEqual({
          cancelled: true
        })
        const stopped = await result(first)

        expect(startedBeforeStop).toBe(false)
        // Claude 2.1.280 echoes the message, then ends that turn as interrupted without replying.
        expect(stopped).toMatchObject({ subtype: 'error_during_execution' })
        expect(replyStarted(first)).toBe(false)

        const second = events.length
        await expect(send('real-cli-stop-2', 'Reply with the single word ok.')).resolves.toEqual({
          state: 'admitted'
        })
        await expect(result(second)).resolves.toMatchObject({ subtype: 'success' })
      } finally {
        await adapter.closeAll()
      }
    },
    150_000
  )

  // Orca installs a SessionStart hook, so its frame proves most real starts before the turn's
  // system/init, the only frame that says this CLI can cancel what it queued.
  it.skipIf(!realClaudeAuthenticated)(
    'withdraws a follow-up queued behind a turn that is stopped, behind a SessionStart hook',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const cwd = await mkdtemp(join(tmpdir(), 'orca-queued-stop-'))
      await mkdir(join(cwd, '.claude'), { recursive: true })
      await writeFile(
        join(cwd, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] }
        })
      )
      const events: ClaudeStructuredSessionEvent[] = []
      const settlements: unknown[] = []
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events, cwd, (settlement) =>
        settlements.push(settlement)
      )
      const send = (clientMessageId: string, text: string) =>
        adapter.dispatch({
          sessionId: 'real-cli-handshake',
          clientMessageId,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
          fence: 1
        })
      const waitFor = async (found: () => boolean): Promise<boolean> => {
        const deadline = Date.now() + 60_000
        while (!found() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return found()
      }

      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-queued-stop'
        })
        await send('real-cli-queued-stop-a', 'Count from 1 to 400, one number per line.')
        // A's reply is streaming, so the next send queues behind its turn.
        await expect(
          waitFor(() =>
            events.some(
              (event) =>
                event.type === 'message' &&
                event.message.type === 'stream_event' &&
                JSON.stringify(event.message).includes('text_delta')
            )
          )
        ).resolves.toBe(true)
        await send('real-cli-queued-stop-b', 'Say the word banana.')

        await expect(
          adapter.cancelTurn({
            sessionId: 'real-cli-handshake',
            turnId: 'turn-a',
            fence: 1,
            resolveLiveTurnId: () => 'turn-a',
            // What the host reads for B: handed over, not yet answered.
            dispatchStatus: { state: 'pending', recovered: false }
          })
        ).resolves.toEqual({ cancelled: true })

        expect(settlements).toContainEqual({
          sessionId: 'real-cli-handshake',
          clientMessageId: 'real-cli-queued-stop-b',
          state: 'rejected',
          reason: 'provider_cancelled_before_start',
          rejection: { kind: 'cancelled' }
        })
      } finally {
        await adapter.closeAll()
        await rm(cwd, { recursive: true, force: true })
      }
    },
    150_000
  )

  // With no SessionStart hook (Orca's status hooks off), the CLI names no session before the
  // first turn; the chat must start on the initialize answer and take the message.
  it.skipIf(!realClaudeAuthenticated)(
    'starts and answers with every hook disabled, so no start frame precedes the turn',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const cwd = await mkdtemp(join(tmpdir(), 'orca-no-hooks-'))
      await mkdir(join(cwd, '.claude'), { recursive: true })
      await writeFile(
        join(cwd, '.claude', 'settings.json'),
        JSON.stringify({ disableAllHooks: true })
      )
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events, cwd)
      const frames = (): Record<string, unknown>[] =>
        events.flatMap((event) => (event.type === 'message' ? [event.message] : []))
      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-no-hooks'
        })
        expect(frames().filter((frame) => readClaudeInit(frame) !== null)).toEqual([])
        await expect(
          adapter.dispatch({
            sessionId: 'real-cli-handshake',
            clientMessageId: 'real-cli-no-hooks-1',
            body: {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'Reply with the single word ok.' }]
            },
            fence: 1
          })
        ).resolves.toEqual({ state: 'admitted' })
        await vi.waitFor(
          () => expect(frames()).toContainEqual(expect.objectContaining({ type: 'result' })),
          { timeout: 120_000, interval: 200 }
        )
      } finally {
        await adapter.closeAll()
        await rm(cwd, { recursive: true, force: true })
      }
    },
    150_000
  )

  it('turns a real silent unauthenticated startup into sign-in guidance', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'orca-claude-no-auth-'))
    const providerSessionId = randomUUID()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = realAdapter(
      providerSessionId,
      claudeConfigDir,
      events,
      process.cwd(),
      undefined,
      {}
    )

    try {
      await adapter.acquire({
        identity: identity(providerSessionId),
        fence: 1,
        spawnToken: 'real-cli-no-auth'
      })
      await adapter.drainObservedExits()
      expect(events.find((event) => event.type === 'ended')).toMatchObject({
        reason: expect.stringMatching(/not signed in.*Claude CLI.*CLAUDE_CONFIG_DIR/s),
        startupUnproven: true
      })
    } finally {
      await adapter.closeAll()
      await rm(claudeConfigDir, { recursive: true, force: true })
    }
  }, 10_000)
})
