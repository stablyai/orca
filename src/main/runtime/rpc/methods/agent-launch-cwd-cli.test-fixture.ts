import type { Mock } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientError, RuntimeRpcFailureError } from '../../../../cli/runtime/types'

type CliOkFixture = {
  id: string
  ok: true
  result: unknown
  _meta: { runtimeId: string }
}

type CliWorktreeFixture = {
  id: string
  repoId: string
  path: string
  branch: string
  parentWorktreeId: string | null
  childWorktreeIds: string[]
  lineage: null
  linkedIssue: null
  git: {
    path: string
    head: string
    branch: string
    isBare: false
    isMainWorktree: false
  }
  displayName: string
  comment: string
  hostId?: string
  identity?: { key: string }
}

export type CliWorktreeBuilder = (
  path: string,
  branch: string,
  head?: string,
  repoId?: string
) => CliWorktreeFixture & { hostId?: ExecutionHostId }

export type RuntimeClientModuleMockFactory = (mocks: {
  callMock: Mock
  runtimeClientConstructorMock: Mock
  serveOrcaAppMock: Mock
  getDefaultUserDataPathMock: Mock
}) => Promise<{
  RuntimeClient: new (
    userDataPath?: string,
    requestTimeoutMs?: number,
    remotePairingCode?: string | null,
    environmentSelector?: string | null
  ) => {
    readonly isRemote: boolean
    call: Mock
    getCliStatus: Mock
    openOrca: Mock
  }
  RuntimeClientError: typeof RuntimeClientError
  RuntimeRpcFailureError: typeof RuntimeRpcFailureError
  serveOrcaApp: Mock
  getDefaultUserDataPath: Mock
}>

// The CLI has its own compiler project; retain real bindings at the test's existing import boundary.
const cliPath = '../../../../cli/index'
const { main }: { main(argv?: string[], cwd?: string): Promise<void> } = await import(cliPath)
const harnessPath = '../../../../cli/index-test-harness'
const {
  useWorktreeAwarenessEnvironment: configureWorktreeAwarenessEnvironment
}: {
  useWorktreeAwarenessEnvironment(mocks: {
    callMock: Mock
    serveOrcaAppMock: Mock
    getDefaultUserDataPathMock: Mock
    addEnvironmentFromPairingCodeMock: Mock
    listEnvironmentsMock: Mock
    spawnMock: Mock
  }): void
} = await import(harnessPath)
const fixturesPath = '../../../../cli/test-fixtures'
const {
  buildWorktree,
  okFixture,
  worktreeListFixture
}: {
  buildWorktree: CliWorktreeBuilder
  okFixture(id: string, result: unknown): CliOkFixture
  worktreeListFixture(worktrees: CliWorktreeFixture[]): CliOkFixture
} = await import(fixturesPath)
const agentFixturesPath = '../../../../cli/agent-launch-test-fixtures'
const { agentLaunchHostFixture }: { agentLaunchHostFixture(): CliOkFixture } = await import(
  agentFixturesPath
)

export {
  main,
  configureWorktreeAwarenessEnvironment,
  buildWorktree,
  okFixture,
  worktreeListFixture,
  agentLaunchHostFixture
}
