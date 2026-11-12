import { vi } from 'vitest'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { PtyBindingPersistenceOperations } from '../../../persistence/loading-store/terminal-bindings/pty-binding-persistence'
import { ptyBindingGenerationOf } from '../../../persistence/loading-store/terminal-bindings/pty-binding-generations'
import type { Store } from '../../../persistence/loading-store/store'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import { installPtyRuntimeController } from '../../../ipc/pty/runtime/controller'
import { adoptStablePane } from '../../../ipc/pty/pane/adopt-stable'
import type { AdoptStablePaneArgs } from '../../../ipc/pty/ipc/spawn-types'
import { finishPtyShutdown } from '../../../ipc/pty/provider/liveness'
import { localProvider, setLocalPtyProvider } from '../../../ipc/pty/provider/registry'
import { clearProviderPtyState } from '../../../ipc/pty/provider/state-cleanup'
import { ptyOwnership } from '../../../ipc/pty/provider/ownership-state'
import {
  assertWorkspaceAcceptsNewPty,
  resolvePtySpawnStartupCwd
} from '../../../ipc/pty/host-env/spawn-cwd'
import {
  noCodexResumeLaunch,
  reconcileSharedRuntimeResumeHome,
  resolveCodexResumeLaunch,
  stripSequencedStartupResumeArgv
} from '../../../ipc/pty/host-env/codex-resume'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  TEST_WORKTREE_ID
} from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { leaveSpawnsUncommitted } from '../../orca-runtime-tests/bind-first-pane.test-fixture'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'

class ReplacementRuntime extends OrcaRuntimeService {
  readonly admitted = deferred<void>()
  readonly continueAdmission = deferred<void>()

  protected override async workspaceUsesBareGitStorage(): Promise<boolean> {
    return false
  }

  override setPtyController(controller: RuntimePtyController | null): void {
    // This controller commits its own bindings; the runtime fixture must not synthesize them.
    super.setPtyController(controller ? leaveSpawnsUncommitted(controller) : null)
  }

  override async acquireWorktreeTerminalSpawn(
    ...args: Parameters<OrcaRuntimeService['acquireWorktreeTerminalSpawn']>
  ): Promise<() => void> {
    const release = await super.acquireWorktreeTerminalSpawn(...args)
    this.admitted.resolve()
    await this.continueAdmission.promise
    return release
  }

  startExistingPane(args: Parameters<NonNullable<RuntimePtyController['spawn']>>[0]) {
    if (!this.ptyController?.spawn) {
      throw new Error('PTY controller unavailable')
    }
    return this.ptyController.spawn(args)
  }

  exclusiveWorkspaceAction<T>(operation: () => Promise<T>): Promise<T> {
    return this.runWorktreeTerminalMutation(TEST_WORKTREE_ID, operation)
  }
}

/** Real layout/runtime/controller and binding writes over the checkout catalog fixture. */
export function layoutPaneReplacementController() {
  const fixture = makeRuntimeStoreWithWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
  const state = {
    ...getDefaultPersistedState('/tmp/layout-pane-replacement'),
    get workspaceSession() {
      return fixture.getSession()
    },
    set workspaceSession(session) {
      fixture.setSession(session)
    }
  }
  const bindingRuntime = {
    state,
    dirtyProfileStateDomains: new Set<string>(),
    runDurableMutation: fixture.runtimeStore.runDurableMutation,
    writeTimer: null,
    pendingWrite: null,
    quitFlushStarted: false,
    writeGeneration: 0,
    lastDurableWriteGeneration: 0,
    ptyBindingGenerations: new Map<string, number>()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: binding operations use only the fixture's host-session accessors, not the Store's private contexts.
  const sessions = fixture.runtimeStore as unknown as ConstructorParameters<
    typeof PtyBindingPersistenceOperations
  >[1]
  const bindings = new PtyBindingPersistenceOperations(bindingRuntime, sessions)
  const controllerStoreMembers = {
    getSettings: (): ReturnType<Store['getSettings']> => ({
      ...state.settings,
      terminalDefaultShell: '/bin/zsh',
      terminalWindowsShell: 'powershell.exe',
      terminalWindowsWslDistro: null
    }),
    persistPtyBinding: vi.fn(bindings.persistPtyBinding.bind(bindings)),
    retirePtyBinding: bindings.retirePtyBinding.bind(bindings),
    getPtyBindingGeneration: ptyBindingGenerationOf.bind(null, bindingRuntime)
  }
  const runtimeStore: Omit<typeof fixture.runtimeStore, keyof typeof controllerStoreMembers> &
    typeof controllerStoreMembers = Object.assign(fixture.runtimeStore, controllerStoreMembers)
  const durableSessions: ReturnType<typeof fixture.getSession>[] = []
  runtimeStore.flushOrThrow.mockImplementation(() => {
    durableSessions.push(structuredClone(fixture.getSession()))
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this in-memory Store supplies the session, binding and workspace reads used by the real controller.
  const store = runtimeStore as unknown as Store
  const runtime = new ReplacementRuntime(runtimeStore)
  const previousProvider = localProvider
  const provider = new LocalPtyProvider()
  const dispatched = deferred<void>()
  const spawned = deferred<PtySpawnResult>()
  const spawn = vi.spyOn(provider, 'spawn').mockImplementation(() => {
    dispatched.resolve()
    return spawned.promise
  })
  const shutdown = vi.spyOn(provider, 'shutdown').mockResolvedValue(undefined)
  vi.spyOn(provider, 'listProcesses').mockResolvedValue([])
  setLocalPtyProvider(provider)
  const adopt = vi.fn((args: AdoptStablePaneArgs) => adoptStablePane(runtime, store, args))
  installPtyRuntimeController({
    runtime,
    store,
    adoptStablePane: adopt,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    assertWorkspaceAcceptsNewPty: (...args) => assertWorkspaceAcceptsNewPty(store, ...args),
    resolvePtySpawnStartupCwd: (...args) => resolvePtySpawnStartupCwd(store, ...args),
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async (owner, id, opts) => {
      await owner.shutdown(id, opts)
      return false
    },
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch,
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome,
    stripSequencedStartupResumeArgv,
    getSettings: runtimeStore.getSettings,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map()
  })
  return {
    runtime,
    runtimeStore,
    adopt,
    spawn,
    shutdown,
    dispatched: dispatched.promise,
    spawned,
    durableSessions,
    getSession: fixture.getSession,
    restoreProvider: () => {
      runtime.setPtyController(null)
      clearProviderPtyState('replacement-pty')
      ptyOwnership.delete('replacement-pty')
      setLocalPtyProvider(previousProvider)
    }
  }
}
