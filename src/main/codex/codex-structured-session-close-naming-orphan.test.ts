import { describe, expect, it, vi } from 'vitest'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexConversationNamingTask } from './codex-conversation-naming-task'
import { CodexNamingOrphanRegistry } from './codex-naming-orphan-registry'
import { closeAllCodexSessions, closeCodexPublishedSession } from './codex-structured-session-close'
import { CodexAcquisitionRegistry, type CodexSession } from './codex-structured-session-state'

const THREAD = 'thread-1'

function connectionStub(exits: boolean): CodexAppServerConnection {
  return {
    pid: 4321,
    closed: true,
    request: async () => ({}),
    notify: () => {},
    respond: () => {},
    respondWithError: () => {},
    close: async () => exits
  } as unknown as CodexAppServerConnection
}

function sessionStub(input: {
  connection: CodexAppServerConnection
  naming: CodexConversationNamingTask | null
}): CodexSession {
  return {
    connection: input.connection,
    ended: false,
    requestedClose: false,
    backgroundTasks: new CodexBackgroundTaskTracker(THREAD),
    fence: 7,
    acquisitionGeneration: 'generation-1',
    threadId: THREAD,
    historyPath: null,
    cwd: '/work/repo',
    launch: {
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    },
    conversationName: null,
    conversationNameRevision: 0,
    naming: input.naming,
    namingAttempted: false,
    prompts: { clear: vi.fn() } as unknown as CodexSession['prompts'],
    options: new Map(),
    reportedOptions: {},
    turnIdWaiters: [],
    translator: {
      handle: vi.fn().mockReturnValue({ accepted: true }),
      dispose: vi.fn()
    } as unknown as NonNullable<CodexSession['translator']>
  } as CodexSession
}

describe('Codex session close with an unproven naming child', () => {
  it('closes the session when the user connection exits but naming will not die', async () => {
    // The regression: a wedged best-effort title generator used to fail the
    // close, which made acquisition throw and left the chat unusable.
    const naming = { close: vi.fn(async () => false) } as unknown as CodexConversationNamingTask
    const session = sessionStub({ connection: connectionStub(true), naming })
    const sessions = new Map([['session-1', session]])
    const namingOrphans = new CodexNamingOrphanRegistry()

    const closed = await closeCodexPublishedSession(sessions, 'session-1', undefined, {
      namingOrphans
    })

    expect(closed).toBe(true)
    expect(sessions.has('session-1')).toBe(false)
    expect(naming.close).toHaveBeenCalled()
  })

  it('still refuses the close when the user connection cannot prove its exit', async () => {
    const naming = { close: vi.fn(async () => true) } as unknown as CodexConversationNamingTask
    const session = sessionStub({ connection: connectionStub(false), naming })
    const sessions = new Map([['session-1', session]])

    const closed = await closeCodexPublishedSession(sessions, 'session-1', undefined, {
      namingOrphans: new CodexNamingOrphanRegistry()
    })

    expect(closed).toBe(false)
    expect(sessions.has('session-1')).toBe(true)
  })

  it('kills the naming child even when no orphan registry is wired', async () => {
    const naming = { close: vi.fn(async () => false) } as unknown as CodexConversationNamingTask
    const session = sessionStub({ connection: connectionStub(true), naming })

    const closed = await closeCodexPublishedSession(new Map([['session-1', session]]), 'session-1')

    expect(closed).toBe(true)
    expect(naming.close).toHaveBeenCalled()
  })

  it('retries an adopted child until shutdown can prove it stopped', async () => {
    let attempts = 0
    const naming = {
      close: vi.fn(async () => {
        attempts += 1
        return attempts > 1
      })
    } as unknown as CodexConversationNamingTask
    const namingOrphans = new CodexNamingOrphanRegistry()
    const sessions = new Map([
      ['session-1', sessionStub({ connection: connectionStub(true), naming })]
    ])

    await closeCodexPublishedSession(sessions, 'session-1', undefined, { namingOrphans })
    expect(namingOrphans.size).toBe(1)

    await closeAllCodexSessions(
      sessions,
      new CodexAcquisitionRegistry(),
      async () => true,
      namingOrphans
    )

    expect(namingOrphans.size).toBe(0)
  })

  it('fails shutdown when an adopted child never proves its exit', async () => {
    const naming = { close: vi.fn(async () => false) } as unknown as CodexConversationNamingTask
    const namingOrphans = new CodexNamingOrphanRegistry()
    const sessions = new Map([
      ['session-1', sessionStub({ connection: connectionStub(true), naming })]
    ])

    await closeCodexPublishedSession(sessions, 'session-1', undefined, { namingOrphans })

    await expect(
      closeAllCodexSessions(
        sessions,
        new CodexAcquisitionRegistry(),
        async () => true,
        namingOrphans
      )
    ).rejects.toThrow(/could not prove every child stopped/)
  })
})
