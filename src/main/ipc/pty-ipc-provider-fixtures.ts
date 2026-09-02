import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'
import { makeDisposable } from './pty-ipc-test-constants'

/** The node-pty process double plus the emitters that drive its registered handlers. */
export type MockPtyProcess = {
  proc: { onData: Mock; onExit: Mock; write: Mock; resize: Mock; kill: Mock }
  emitData: (data: string) => void
  emitExit: (exitCode?: number) => void
}

/** Daemon provider double whose stream handlers stay reachable through emitters. */
export type ObservableDaemonProviderDouble = {
  spawn: Mock
  write: Mock
  pauseProducer: Mock
  resumeProducer: Mock
  setPtyBackgrounded: Mock
  shutdown: Mock
  getBufferSnapshot: Mock
  emitData: (id: string, data: string) => void
  emitExit: (id: string, code?: number) => void
  emitDataGap: (id: string, droppedChars: number) => void
}

/** Provider double used by agent-claim/ownership suites; every member is a bare spy. */
export type AgentClaimProviderDouble = Record<
  | 'spawn'
  | 'write'
  | 'resize'
  | 'shutdown'
  | 'sendSignal'
  | 'getCwd'
  | 'getInitialCwd'
  | 'clearBuffer'
  | 'acknowledgeDataEvent'
  | 'hasChildProcesses'
  | 'getForegroundProcess'
  | 'serialize'
  | 'revive'
  | 'onData'
  | 'onReplay'
  | 'onExit'
  | 'listProcesses'
  | 'providesAgentSessionOwnerListings'
  | 'hasPty'
  | 'attach'
  | 'getDefaultShell'
  | 'getProfiles',
  Mock
>

/** Provider doubles + the runtime-controller registration shared by every pty IPC suite file. */
export function createPtyIpcProviderFixtures(ctx: { mainWindow: unknown }) {
  const { mainWindow } = ctx
  function createMockProc(): MockPtyProcess {
    let dataHandler: ((data: string) => void) | null = null
    let exitHandler: ((event: { exitCode: number }) => void) | null = null

    return {
      proc: {
        onData: vi.fn((handler: (data: string) => void) => {
          dataHandler = handler
          return makeDisposable()
        }),
        onExit: vi.fn((handler: (event: { exitCode: number }) => void) => {
          exitHandler = handler
          return makeDisposable()
        }),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn()
      },
      emitData(data: string) {
        dataHandler?.(data)
      },
      emitExit(exitCode = 0) {
        exitHandler?.({ exitCode })
      }
    }
  }
  function installDaemonTestProvider(overrides: Record<string, unknown> = {}): Mock {
    const spawn = vi.fn(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty'
    }))
    const provider = {
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      confirmForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      ...overrides
    }
    setLocalPtyProvider(provider as never)
    return spawn
  }

  function installObservableDaemonTestProvider(): ObservableDaemonProviderDouble {
    const spawn = vi.fn(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty'
    }))
    const write = vi.fn()
    const pauseProducer = vi.fn()
    const resumeProducer = vi.fn()
    const setPtyBackgrounded = vi.fn()
    const shutdown = vi.fn()
    let dataHandler: ((payload: { id: string; data: string }) => void) | null = null
    let exitHandler: ((payload: { id: string; code: number }) => void) | null = null
    let backgroundStreamHandler:
      | ((payload: { id: string; kind: 'dataGap'; droppedChars: number }) => void)
      | null = null
    const getBufferSnapshot = vi.fn()
    setLocalPtyProvider({
      spawn,
      write,
      resize: vi.fn(),
      pauseProducer,
      resumeProducer,
      setPtyBackgrounded,
      kill: vi.fn(),
      shutdown,
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      confirmForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn((handler: (payload: { id: string; data: string }) => void) => {
        dataHandler = handler
        return () => {}
      }),
      onReplay: vi.fn(() => () => {}),
      onBackgroundStreamEvent: vi.fn(
        (handler: (payload: { id: string; kind: 'dataGap'; droppedChars: number }) => void) => {
          backgroundStreamHandler = handler
          return () => {}
        }
      ),
      getBufferSnapshot,
      onExit: vi.fn((handler: (payload: { id: string; code: number }) => void) => {
        exitHandler = handler
        return () => {}
      }),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    return {
      spawn,
      write,
      pauseProducer,
      resumeProducer,
      setPtyBackgrounded,
      shutdown,
      getBufferSnapshot,
      emitData: (id: string, data: string) => dataHandler?.({ id, data }),
      emitExit: (id: string, code = 0) => exitHandler?.({ id, code }),
      emitDataGap: (id: string, droppedChars: number) =>
        backgroundStreamHandler?.({ id, kind: 'dataGap', droppedChars })
    }
  }

  function createAgentClaimProvider(args: {
    sessions?: {
      id: string
      incarnationId?: string
      cwd: string
      title: string
      agentSessionOwners?: AgentSessionOwnerBinding[]
    }[]
    livePtyIds?: ReadonlySet<string>
    spawn?: Mock
    authoritativeOwnerListings?: boolean
  }): AgentClaimProviderDouble {
    return {
      spawn: args.spawn ?? vi.fn(async () => ({ id: 'unexpected-spawn' })),
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => args.sessions ?? []),
      providesAgentSessionOwnerListings: vi.fn(() => args.authoritativeOwnerListings !== false),
      hasPty: vi.fn((id: string) => args.livePtyIds?.has(id) ?? false),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    }
  }

  const recoveredAgentClaim = {
    digestVersion: 1 as const,
    keyId: 'claim-key',
    identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    agent: 'codex' as const
  }
  const recoveredAgentSurface = {
    worktreeId: 'repo-1::/tmp/recovered-worktree',
    tabId: '11111111-1111-4111-8111-111111111111',
    leafId: '22222222-2222-4222-8222-222222222222',
    terminalHandle: 'term_recovered'
  }

  function registerAgentClaimController(runtimeOverrides: Record<string, unknown> = {}): {
    spawn: (args: Record<string, unknown>) => Promise<unknown>
    write: (ptyId: string, data: string) => boolean
    resize: (ptyId: string, cols: number, rows: number) => boolean
    probePtyLiveness: (ptyId: string) => Promise<boolean | null>
    attach: (ptyId: string) => Promise<boolean>
  } {
    let controller:
      | {
          spawn: (args: Record<string, unknown>) => Promise<unknown>
          write: (ptyId: string, data: string) => boolean
          resize: (ptyId: string, cols: number, rows: number) => boolean
          probePtyLiveness: (ptyId: string) => Promise<boolean | null>
          attach: (ptyId: string) => Promise<boolean>
        }
      | undefined
    const runtime = {
      setPtyController: vi.fn((next) => {
        controller = next
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_recovered'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      ...runtimeOverrides
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    if (!controller) {
      throw new Error('PTY controller was not registered')
    }
    return controller
  }

  return {
    createMockProc,
    installDaemonTestProvider,
    installObservableDaemonTestProvider,
    createAgentClaimProvider,
    recoveredAgentClaim,
    recoveredAgentSurface,
    registerAgentClaimController
  }
}
