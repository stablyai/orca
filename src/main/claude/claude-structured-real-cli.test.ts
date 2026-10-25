import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import * as claudeConnection from './claude-stream-json-connection'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  claudeStructuredPermissionOptions
} from './claude-structured-launch-resolution'
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
import { claudeOpened, claudeStartupSettled } from './claude-structured-session-test-support'
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
    resolveLaunch: async ({ permissionMode }) => {
      const permission = claudeStructuredPermissionOptions(permissionMode ?? 'ask')
      return {
        pathToClaudeCodeExecutable: command,
        options: {
          ...CLAUDE_STRUCTURED_BASE_OPTIONS,
          ...permission,
          extraArgs: { ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs, ...permission.extraArgs },
          sessionId: providerSessionId
        },
        cwd,
        env,
        claudeConfigDir,
        providerSessionId,
        resumeLeafUuid: null,
        resumesTranscript: false,
        continuesChain: false
      }
    },
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

/** Isolate SessionStart proof from the machine's hook settings. */
async function projectWithStartHook(
  prefix: string,
  settings: Record<string, unknown> = {}
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(join(cwd, '.claude'), { recursive: true })
  await writeFile(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({
      ...settings,
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] }
    })
  )
  return cwd
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
    // Match mobile lookup: no project-root override.
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
      const cwd = await projectWithStartHook('orca-command-init-')
      await mkdir(join(cwd, '.claude', 'commands'), { recursive: true })
      await writeFile(
        join(cwd, '.claude', 'commands', 'orca-init-catalog-proof.md'),
        '---\ndescription: Initialization catalog proof\n---\nReply with OK.\n'
      )
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events, cwd)

      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli'
        })
        await claudeStartupSettled(adapter, 'real-cli-handshake')
        const observedSubtypes = events.flatMap((event) =>
          event.type === 'message' ? [event.message.subtype] : []
        )

        // Startup frame UUIDs are not resumable transcript leaves.
        expect((await claudeOpened(adapter, 'real-cli-handshake')).link?.handle).toEqual(
          claudeProviderHandle(providerSessionId, null)
        )
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

  it.skipIf(!realClaudeAuthenticated)(
    'reports the current effort through get_settings and never on the init frame',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const events: ClaudeStructuredSessionEvent[] = []
      const cwd = await projectWithStartHook('orca-effort-readback-', { effortLevel: 'low' })
      const adapter = realAdapter(providerSessionId, claudeConfigDir, events, cwd)

      try {
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-effort'
        })
        await claudeStartupSettled(adapter, 'real-cli-handshake')
        const published = events.flatMap((event) =>
          event.type === 'message' ? [event.message] : []
        )
        const options = await adapter.readOptions({ sessionId: 'real-cli-handshake', fence: 1 })

        expect(published.length).toBeGreaterThan(0)
        // Startup proof varies by host, so inspect every published frame.
        expect(published.filter((frame) => 'effortLevel' in frame)).toEqual([])
        expect(options.current.effort).toBe('low')
      } finally {
        await adapter.closeAll()
        await rm(cwd, { recursive: true, force: true })
      }
    },
    15_000
  )

  // Use the CLI-reported project root so resolver and expectation cannot share a path bug.
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
        await claudeStartupSettled(adapter, 'real-cli-handshake')
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
      expect(relative(cliProjectsDir, transcriptPath ?? '').split(/[\\/]/)).toHaveLength(2)
      expect(join(claudeConfigDir, 'projects')).toBe(cliProjectsDir)
    },
    45_000
  )

  // set_model accepts nonexistent IDs; only a later init proves the model was adopted.
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
        await claudeStartupSettled(adapter, 'real-cli-handshake')
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
        expect(frames[0]?.model).toEqual(expect.any(String))
        expect(frames[0]?.model).toMatch(/^claude-haiku-/)
        await expect(
          adapter.readOptions({ sessionId: 'real-cli-handshake', fence: 1 })
        ).resolves.toMatchObject({
          current: { model: 'haiku', confirmed: expect.arrayContaining(['model']) }
        })
      } finally {
        await adapter.closeAll()
      }
    },
    90_000
  )

  it.skipIf(!realClaudeAuthenticated)(
    'opens with nothing sent, then answers a send handed over after it',
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
      const until = async (done: () => boolean, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs
        while (!done() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        return done()
      }
      try {
        const acquireAt = Date.now()
        await adapter.acquire({
          identity: identity(providerSessionId),
          fence: 1,
          spawnToken: 'real-cli-started-timing'
        })
        await claudeStartupSettled(adapter, 'real-cli-handshake')
        const publishedAt = Date.now()
        await claudeStartupSettled(adapter, 'real-cli-handshake')
        const startedAt = Date.now()
        const before = events.length
        await adapter.dispatch({
          sessionId: 'real-cli-handshake',
          clientMessageId: 'real-cli-started-timing-1',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Say ok' }] },
          fence: 1
        })
        expect(
          await until(() => events.slice(before).some((event) => event.type === 'message'), 60_000)
        ).toBe(true)
        const firstOutputAt = Date.now()
        console.info(
          `[real-cli startup timing] acquire->published ${publishedAt - acquireAt} ms, ` +
            `published->open ${startedAt - publishedAt} ms, ` +
            `dispatch->first output ${firstOutputAt - startedAt} ms`
        )
      } finally {
        await adapter.closeAll()
      }
    },
    120_000
  )

  it.skipIf(!realClaudeAuthenticated).each([
    ['accept-edits', 'acceptEdits'],
    ['auto', 'auto'],
    ['full-access', 'bypassPermissions']
  ] as const)(
    'runs a message after open with saved options and %s',
    async (permissionMode, cliPermissionMode) => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const cwd = await mkdtemp(join(tmpdir(), 'orca-claude-permissions-'))
      const events: ClaudeStructuredSessionEvent[] = []
      const adapter = realAdapter(
        providerSessionId,
        claudeConfigDir,
        events,
        cwd,
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
          options: { model: 'sonnet', effort: 'low' },
          permissionMode
        })
        await claudeStartupSettled(adapter, 'real-cli-handshake')
        const dispatched = await adapter.dispatch({
          sessionId: 'real-cli-handshake',
          clientMessageId: 'real-cli-saved-options-1',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text:
                  permissionMode === 'auto'
                    ? 'Use tools to write auto-mode-proof.txt containing exactly AUTO_MODE_OK, then read it back. Reply with exactly: OK.'
                    : 'Reply with exactly: OK. Do not use any tools.'
              }
            ]
          },
          fence: 1
        })
        expect(dispatched).toMatchObject({ state: 'admitted' })
        const deadline = Date.now() + 90_000
        while (!messages().some((m) => m.type === 'result') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }

        expect(messages()).toContainEqual(expect.objectContaining({ type: 'user', isReplay: true }))
        expect(messages().find((m) => m.type === 'result')).toMatchObject({ is_error: false })
        expect(messages().find((m) => m.type === 'system' && m.subtype === 'init')).toMatchObject({
          model: expect.stringMatching(/^claude-sonnet-/),
          permissionMode: cliPermissionMode
        })
        if (permissionMode === 'auto') {
          expect((await readFile(join(cwd, 'auto-mode-proof.txt'), 'utf8')).trim()).toBe(
            'AUTO_MODE_OK'
          )
        }
      } finally {
        await adapter.closeAll()
        await rm(cwd, { recursive: true, force: true })
      }
    },
    120_000
  )

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
        await claudeStartupSettled(adapter, 'real-cli-handshake')
        const first = events.length
        await expect(
          send('real-cli-stop-1', 'Count from 1 to 300, one number per line, and nothing else.')
        ).resolves.toMatchObject({ state: 'admitted' })
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
        await expect(
          send('real-cli-stop-2', 'Reply with the single word ok.')
        ).resolves.toMatchObject({
          state: 'admitted'
        })
        await expect(result(second)).resolves.toMatchObject({ subtype: 'success' })
      } finally {
        await adapter.closeAll()
      }
    },
    150_000
  )

  // SessionStart can prove startup before system/init advertises queue-cancellation support.
  it.skipIf(!realClaudeAuthenticated)(
    'withdraws a follow-up queued behind a turn that is stopped, behind a SessionStart hook',
    async () => {
      const providerSessionId = randomUUID()
      const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
      const cwd = await projectWithStartHook('orca-queued-stop-')
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
        await claudeStartupSettled(adapter, 'real-cli-handshake')
        await send('real-cli-queued-stop-a', 'Count from 1 to 400, one number per line.')
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
            dispatchStatus: { state: 'pending', recovered: false }
          })
        ).resolves.toEqual({ cancelled: true })

        expect(settlements).toContainEqual({
          sessionId: 'real-cli-handshake',
          clientMessageId: 'real-cli-queued-stop-b',
          state: 'rejected',
          reason: 'provider_cancelled_before_start',
          rejection: { kind: 'cancelled' },
          unrun: true
        })
      } finally {
        await adapter.closeAll()
        await rm(cwd, { recursive: true, force: true })
      }
    },
    150_000
  )

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
        await claudeStartupSettled(adapter, 'real-cli-handshake')
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
        ).resolves.toMatchObject({ state: 'admitted' })
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
      {},
      false
    )

    try {
      await adapter.acquire({
        identity: identity(providerSessionId),
        fence: 1,
        spawnToken: 'real-cli-no-auth'
      })
      await expect(claudeStartupSettled(adapter, 'real-cli-handshake')).rejects.toThrow(
        /not signed in.*Claude CLI.*CLAUDE_CONFIG_DIR/s
      )
    } finally {
      await adapter.closeAll()
      await rm(claudeConfigDir, { recursive: true, force: true })
    }
  }, 10_000)
})
