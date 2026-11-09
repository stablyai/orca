import type { AcquisitionArgs } from '../../ipc/pty/pane/legacy-pane-acquisition-context'
import { admitProspectivePtySpawn } from '../../pty/prospective-pty-spawn'
import { expect, onTestFinished, vi } from 'vitest'
import { fixture, deferred } from './profile-state-delayed-authority-fixture'
import { getAppEnvironment, setAppEnvironment } from '../../../shared/app-environment'
import { acquireOrcadInstanceLock } from '../../orcad/orcad-instance-lock'
import { HistoryManager } from '../../daemon/history/storage/history-manager'
import { HistoryReader } from '../../daemon/history/restoration/history-reader'
import { getDaemonHistoryDir, getDaemonRuntimeDir } from '../../daemon/launch/daemon-launch-paths'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import { createPtySpawnCommitDependencies } from './pty-spawn-commit-dependencies-fixture'
import { runPtySpawn } from '../../ipc/pty/spawn-operation'
import { adoptStablePane } from '../../ipc/pty/pane/adopt-stable'
import { savePtySpawnPaneBinding } from '../../ipc/pty/spawn-commit-binding'
import { admitPtySpawnOwnership } from '../../ipc/pty/pane/spawn-registration'
import { setLocalPtyProvider } from '../../ipc/pty/provider/registry'
import { SessionNotFoundError } from '../../daemon/protocol/daemon-errors'
import type { IPtyProvider, PtySpawnOptions } from '../../providers/pty-provider-contract'
import { terminalSurfaceCloseMutation } from '../../runtime/terminal/surface/terminal-surface-close'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../../daemon/launch/daemon-generation-liveness', () => ({
  listLiveDaemonProtocols: async () => []
}))
vi.mock('../../ipc/pty/host-env/assembly', () => ({
  buildPtyHostEnv: async (_id: string, env: Record<string, string> | undefined) => ({ ...env })
}))

export const workspace = 'repo-local::/fixture/local'
export const tabId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const leafId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const paneKey = `${tabId}:${leafId}`

export async function restoreFixture() {
  const { store, readState, authority } = await fixture()
  const profile = store.getProfileStorageDirectory()
  const environment = getAppEnvironment()
  setAppEnvironment({
    ...environment,
    getPath: (name) => (name === 'userData' ? profile : environment.getPath(name))
  })
  const lock = acquireOrcadInstanceLock(profile)
  const history = new HistoryManager(getDaemonHistoryDir())
  await history.identityRoot!.bindProfile(profile, getDaemonRuntimeDir(), () => [])
  await history.openSession('9', { cwd: '/fixture/local', cols: 80, rows: 24 })
  await history.checkpoint('9', {
    snapshotAnsi: 'old terminal screen',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: '/fixture/local',
    cols: 80,
    rows: 24,
    scrollbackLines: 0,
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    }
  })
  await store.admitTerminalPane({ type: 'createTerminalTab', workspace, tabId, leafId })
  // Legacy renderer-owned snapshots predate main's membership watermark.
  delete store.getWorkspaceSession().terminalTopologyRevisionByRepoId
  await store.persistPtyBinding({
    worktreeId: workspace,
    tabId,
    leafId,
    ptyId: '9',
    mayCreate: false
  })
  expect(store.legacyTerminalIdentityAuthority.unique(workspace, paneKey, '9')).toBe(true)
  const legacySnapshot = structuredClone(store.getWorkspaceSession())
  const alive = new Set<string>()
  const seen: { id: string; attachOnly: boolean }[] = []
  const incarnations = new Map<string, string>()
  let nextFresh: ReturnType<typeof deferred<void>> | undefined
  let freshDispatched: ReturnType<typeof deferred<void>> | undefined
  let nextProbe: ReturnType<typeof deferred<void>> | undefined
  let dispatched: ReturnType<typeof deferred<void>> | undefined
  const unexpectedEffect = (): never => {
    throw new Error('Unexpected provider effect during restore')
  }
  const provider = {
    attach: unexpectedEffect,
    write: unexpectedEffect,
    writeWithSettlement: unexpectedEffect,
    resize: unexpectedEffect,
    sendSignal: unexpectedEffect,
    getCwd: unexpectedEffect,
    getInitialCwd: unexpectedEffect,
    clearBuffer: unexpectedEffect,
    resetInputModes: unexpectedEffect,
    acknowledgeDataEvent: unexpectedEffect,
    hasChildProcesses: unexpectedEffect,
    getForegroundProcess: unexpectedEffect,
    serialize: unexpectedEffect,
    revive: unexpectedEffect,
    listProcesses: unexpectedEffect,
    getDefaultShell: unexpectedEffect,
    getProfiles: unexpectedEffect,
    onData: unexpectedEffect,
    onReplay: unexpectedEffect,
    onExit: unexpectedEffect,
    spawn: vi.fn(async (options: PtySpawnOptions) => {
      const id = options.sessionId!
      const endObservation = history.identityRoot!.observeNumeric(id, options.attachOnly !== true)
      return history.identityRoot!.observeWork(id, async () => {
        seen.push({ id, attachOnly: options.attachOnly === true })
        if (options.attachOnly) {
          const gate = nextProbe
          nextProbe = undefined
          dispatched?.resolve()
          await gate?.promise
          if (!alive.has(id)) {
            endObservation(true)
            throw new SessionNotFoundError(id)
          }
        }
        endObservation(false)
        const restored = await new HistoryReader(getDaemonHistoryDir()).detectColdRestore(id, {
          ignoreCleanEnd: true
        })
        const reattached = alive.has(id)
        alive.add(id)
        incarnations.set(id, `incarnation-${id}`)
        if (!options.attachOnly) {
          freshDispatched?.resolve()
          await nextFresh?.promise
          nextFresh = undefined
        }
        return {
          id,
          incarnationId: `incarnation-${id}`,
          ...(options.attachOnly || reattached ? { isReattach: true as const } : {}),
          ...(restored
            ? { coldRestore: { scrollback: restored.snapshotAnsi, cwd: restored.cwd } }
            : {})
        }
      })
    }),
    supportsFencedTermination: () => true,
    killFenced: vi.fn<NonNullable<IPtyProvider['killFenced']>>(
      async ({ id, expectedIncarnationId }) => {
        if (expectedIncarnationId !== incarnations.get(id)) {
          return { outcome: 'refused' as const, reason: 'replaced' as const }
        }
        alive.delete(id)
        return { outcome: 'ended' as const }
      }
    ),
    shutdown: vi.fn(async (id: string) => {
      alive.delete(id)
    })
  } satisfies IPtyProvider
  Object.assign(provider, {
    [admitProspectivePtySpawn]: async () => ({
      current: () => true,
      currentSync: () => true,
      release: () => {}
    })
  })
  setLocalPtyProvider(provider)
  const start = (failBind = false, targetTabId = tabId, targetStore = store, late = false) => {
    const commitDeps = createPtySpawnCommitDependencies(undefined, targetStore)
    Object.defineProperty(commitDeps, 'mainWindow', { value: null })
    const deps = {
      ...commitDeps,
      runtime: undefined,
      getLocalPtyStartupPromise: () => undefined,
      resolvePtySpawnStartupCwd: (_workspace: string | undefined, cwd: string | undefined) => cwd,
      adoptStablePane: (args: AcquisitionArgs) => adoptStablePane(undefined, targetStore, args)
    }
    const ctx = createRuntimePtySpawnState(deps, {
      cols: 80,
      rows: 24,
      worktreeId: workspace,
      ...(late ? {} : { tabId: targetTabId, leafId }),
      sessionId: '9',
      cwd: '/fixture/local'
    })
    return runPtySpawn({
      state: ctx,
      prepare: async () => {
        ctx.provider = provider
        ctx.effectiveSessionAppId = ctx.args.sessionId
        ctx.spawnOptions = {
          cols: 80,
          rows: 24,
          cwd: '/fixture/local',
          sessionId: ctx.args.sessionId,
          signal: ctx.args.signal,
          env: { ORCA_PANE_KEY: `${ctx.args.tabId ?? targetTabId}:${ctx.args.leafId ?? leafId}` }
        }
      },
      facts: () => ({
        sessionId: ctx.spawnOptions.sessionId,
        paneKey: ctx.spawnOptions.env?.ORCA_PANE_KEY ?? null
      }),
      commit: async () => {
        if (failBind) {
          throw new Error('crash before bind')
        }
        admitPtySpawnOwnership(undefined, ctx.result)
        await savePtySpawnPaneBinding(
          ctx,
          {
            store: targetStore,
            binding: {
              worktreeId: workspace,
              tabId: targetTabId,
              leafId,
              ptyId: ctx.result.id,
              incarnationId: ctx.result.incarnationId,
              mayCreate: false
            },
            absentOwner: ctx.args.paneSpawnOperation?.absentOwner,
            refusal: 'terminal_pane_owner_changed',
            failureLog: 'fixture binding failed'
          },
          null
        )
        return { kind: 'committed', result: ctx.result }
      }
    })
  }
  const close = (targetTabId = tabId, onClosed: (ids: string[]) => void = () => {}) =>
    store.runDurableMutation(
      terminalSurfaceCloseMutation({
        worktreeId: workspace,
        target: { kind: 'tab', tabId: targetTabId },
        options: { force: true, allowMissing: true },
        requestedSession: store.getWorkspaceSession(),
        ownerMatches: () => true,
        hostIds: () => [LOCAL_EXECUTION_HOST_ID],
        getSession: () => store.getWorkspaceSession(),
        setSession: (session) => store.setWorkspaceSession(session),
        identityAuthority: store.legacyTerminalIdentityAuthority,
        onClosed
      })
    )
  onTestFinished(async () => {
    await history.releaseIdentity('detach')
    lock.release()
    setAppEnvironment(environment)
  })
  return {
    store,
    authority,
    start,
    close,
    alive,
    incarnations,
    seen,
    provider,
    legacySnapshot,
    readState,
    profile,
    pauseFresh: () => {
      nextFresh = deferred<void>()
      freshDispatched = deferred<void>()
      return { gate: nextFresh, started: freshDispatched.promise }
    },
    addLegacyPeer: async () => {
      await store.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: 'peer::/other',
        tabId: 'peer-tab',
        leafId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      })
      await store.persistPtyBinding({
        worktreeId: 'peer::/other',
        tabId: 'peer-tab',
        leafId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        ptyId: '9',
        mayCreate: false
      })
    },
    removeSnapshot: () => {
      const next = structuredClone(store.getWorkspaceSession())
      next.tabsByWorktree[workspace] = []
      delete next.terminalLayoutsByTabId[tabId]
      next.unifiedTabs = { ...next.unifiedTabs, [workspace]: [] }
      store.setWorkspaceSession(next)
    },
    pauseProbe: () => {
      nextProbe = deferred<void>()
      dispatched = deferred<void>()
      return { gate: nextProbe, started: dispatched.promise }
    }
  }
}
