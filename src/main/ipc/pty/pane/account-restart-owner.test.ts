import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { savePtySpawnPaneBinding } from '../spawn/spawn-commit-binding'
import { runPtySpawn } from '../spawn/spawn-operation'
import { createRuntimePtySpawnState } from '../runtime/spawn-state'
import { makeRuntimePtySpawnTestDeps } from '../runtime/spawn-preflight-test-deps-fixture'
import { restorePtyIncarnation } from '../provider/ownership-state'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import { DaemonPtyRouter } from '../../../daemon/providers/routing/daemon-pty-router'
import { DaemonPtyAdapter } from '../../../daemon/providers/adapter/daemon-pty-adapter'
import { PROTOCOL_VERSION } from '../../../daemon/protocol/daemon-protocol-version'
import { resolveAccountRestartPane } from '../../../runtime/terminal/recovery/account-restart-pane-snapshot'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { runPtyIpcSpawn } from '../ipc/spawn-run'
import { stopReplacedPanePty } from '../ipc/renderer-kill'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import { spawnPtyFromRuntimeController } from '../runtime/spawn'
import {
  accountRestartErrorReceipt,
  accountRestartSnapshot,
  beginAccountRestartOperation
} from './account-restart-owner'
import { resolveEarlyPaneSpawnReservationKey } from './spawn-pane-coordinates'
import { clearPaneSpawnReservation, reservePaneSpawn } from './spawn-reservation'
import {
  fixture,
  admitRuntimeSpawnPane
} from '../../../persistence/loading-store/profile-writing/profile-state-delayed-authority-fixture'
import { TEST_LEAF_1 } from '../../../persistence/persistence-session-fixtures'
import { releaseStoppedPaneBinding } from './pane-owner-replacement'
import type { ReplacedPaneOwner } from './replaced-pane-owner'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

beforeEach(() => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-restart-profile-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', directory)
  onTestFinished(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })
})

const worktreeId = 'repo-local::/fixture/local'
const tabId = 'restart-tab'

function replaced(ptyId: string): ReplacedPaneOwner {
  return { ptyId, pane: { worktreeId, tabId, leafId: TEST_LEAF_1, hostId: undefined } }
}

type FixtureStore = Awaited<ReturnType<typeof fixture>>['store']

function localRestartProvider(): LocalPtyProvider {
  const previous = getLocalPtyProvider()
  const provider = new LocalPtyProvider()
  setLocalPtyProvider(provider)
  onTestFinished(() => setLocalPtyProvider(previous))
  return provider
}

function rendererRestartDeps(deps: ReturnType<typeof makeRuntimePtySpawnTestDeps>) {
  return {
    ...deps,
    getSettings: () => deps.getSettings?.() ?? getDefaultSettings('/tmp'),
    transitionSpawnHiddenRendererPtyDeliveryState: () => {},
    syncPtyBackgroundedDelivery: () => {},
    stopReplacedPty: (id: string, incarnation?: string, authorize?: () => void) =>
      stopReplacedPanePty(deps, id, incarnation, authorize)
  }
}

function restartPane(store: FixtureStore) {
  const pane = { worktreeId, tabId, leafId: TEST_LEAF_1 }
  return {
    ...pane,
    tabCreatedAt: store
      .getWorkspaceSession()
      .tabsByWorktree[worktreeId].find((tab) => tab.id === tabId)!.createdAt
  }
}

async function bindRestartPane(store: FixtureStore, ptyId: string, incarnationId: string) {
  const pane = { worktreeId, tabId, leafId: TEST_LEAF_1 }
  await admitRuntimeSpawnPane(store, pane)
  await store.persistPtyBinding({ ...pane, ptyId, incarnationId })
  return restartPane(store)
}

function beginHostRestart(
  store: FixtureStore,
  pane: Awaited<ReturnType<typeof bindRestartPane>>,
  ptyId: string,
  incarnationId: string
) {
  const { hostEpoch, bindingGeneration } = accountRestartSnapshot(store, undefined, pane)
  return beginAccountRestartOperation({
    requestId: 'request-1',
    attemptId: 'attempt-1',
    hostEpoch,
    pane,
    expected: { kind: 'endpoint', ptyId, incarnationId, bindingGeneration }
  })
}

it('refuses to restart a live incarnation mismatched with the durable pane binding', async () => {
  const { store } = await fixture()
  const ptyId = 'recycled-account-restart-owner'
  const pane = await bindRestartPane(store, ptyId, '11111111-1111-4111-8111-111111111111')
  restorePtyIncarnation(ptyId, '22222222-2222-4222-8222-222222222222')

  expect(() => accountRestartSnapshot(store, undefined, pane)).toThrow(
    'terminal_pane_owner_unverified'
  )
})

it('answers restart identity for an exact incarnation without returning the launch token', async () => {
  const { store } = await fixture()
  const pane = await bindRestartPane(store, 'bound-restart-pty', 'bound-incarnation')
  const paneKey = makePaneKey(pane.tabId, pane.leafId)
  const pty = {
    ptyId: 'bound-restart-pty',
    incarnationId: 'bound-incarnation',
    launchIncarnationId: 'bound-incarnation',
    launchToken: 'internal-token'
  }
  const runtime = {
    resolveTerminalWorkspaceLaunchScope: vi.fn().mockResolvedValue({ id: worktreeId }),
    resolveTerminalPane: () => ({
      ...pty,
      handle: 'bound-handle',
      tabId: pane.tabId,
      leafId: pane.leafId,
      connected: true
    })
  }
  const matching = await resolveAccountRestartPane(
    runtime,
    store,
    paneKey,
    worktreeId,
    () => pty,
    'internal-token'
  )
  const different = await resolveAccountRestartPane(
    runtime,
    store,
    paneKey,
    worktreeId,
    () => pty,
    'other-token'
  )
  expect(matching.accountRestart?.attempt).toBe('matching')
  expect(different.accountRestart?.attempt).toBe('different')
  expect(matching).not.toHaveProperty('launchToken')
  expect(different).not.toHaveProperty('launchToken')
})

it('leaves the original running when the request aborts behind a pane reservation', async () => {
  const { store } = await fixture()
  const pane = await bindRestartPane(store, 'waiting-owner', 'old-incarnation')
  const abort = new AbortController()
  const args = { ...pane, cols: 80, rows: 24, signal: abort.signal }
  const state = createRuntimePtySpawnState({ ...makeRuntimePtySpawnTestDeps(), store }, args)
  state.accountRestartOperation = beginHostRestart(store, pane, 'waiting-owner', 'old-incarnation')
  const key = resolveEarlyPaneSpawnReservationKey(args)!
  const held = reservePaneSpawn(key)
  const restart = runPtySpawn({
    state,
    facts: () => ({ paneKey: makePaneKey(tabId, TEST_LEAF_1), sessionId: undefined }),
    replace: async () => {
      throw new Error('replacement dispatched')
    },
    prepare: async () => {
      throw new Error('spawn prepared')
    },
    commit: async () => {
      throw new Error('spawn committed')
    }
  })
  abort.abort()
  clearPaneSpawnReservation(key, held)
  held.resolve({ id: 'waiting-owner' })

  await expect(restart).rejects.toThrow('client_disconnected')
})

it.each(['runtime', 'renderer'] as const)(
  'keeps the original running when the %s stop loses its pane generation during provider startup',
  async (entryPoint) => {
    const provider = localRestartProvider()
    const providerStarted = Promise.withResolvers<void>()
    const releaseStartup = Promise.withResolvers<void>()
    const retire = vi.fn()
    vi.spyOn(provider, 'killFenced').mockImplementation(async (_request, authorize) => {
      authorize?.()
      retire()
      return { outcome: 'ended' }
    })
    const { store } = await fixture()
    const pane = await bindRestartPane(store, 'delayed-stop', 'original-incarnation')
    const { condition } = beginHostRestart(store, pane, 'delayed-stop', 'original-incarnation')
    const deps = {
      ...makeRuntimePtySpawnTestDeps(),
      store,
      getLocalPtyProviderStartupPromise: () => {
        providerStarted.resolve()
        return releaseStartup.promise
      }
    }
    const args = { ...pane, cols: 80, rows: 24, accountRestart: condition }
    const pending =
      entryPoint === 'runtime'
        ? spawnPtyFromRuntimeController(deps, args)
        : runPtyIpcSpawn(rendererRestartDeps(deps), args)
    const rejection = expect(pending).rejects.toThrow('terminal_pane_owner_changed')
    try {
      await providerStarted.promise
      await store.persistPtyBinding({ ...pane, ptyId: 'intervening', incarnationId: 'other' })
      await store.persistPtyBinding({
        ...pane,
        ptyId: 'delayed-stop',
        incarnationId: 'original-incarnation'
      })
    } finally {
      releaseStartup.resolve()
    }
    await rejection
    expect(retire).not.toHaveBeenCalled()
  }
)

async function emptyRestartPane(store: FixtureStore) {
  await admitRuntimeSpawnPane(store, { worktreeId, tabId, leafId: TEST_LEAF_1 })
  const pane = restartPane(store)
  const { hostEpoch, bindingGeneration } = accountRestartSnapshot(store, undefined, pane)
  return {
    ...pane,
    cols: 80,
    rows: 24,
    accountRestart: {
      requestId: 'request-new-account',
      attemptId: 'expected-attempt',
      hostEpoch,
      pane,
      expected: { kind: 'empty' as const, bindingGeneration }
    }
  }
}

it.each([
  { reason: 'claimed', stop: 'not-started' },
  { reason: 'unverifiable', stop: 'unknown' }
] as const)('reports $stop after a $reason provider stop refusal', async ({ reason, stop }) => {
  const provider = localRestartProvider()
  vi.spyOn(provider, 'killFenced').mockImplementation(async (_request, authorize) => {
    authorize?.()
    return { outcome: 'refused', reason }
  })
  const { store } = await fixture()
  const pane = await bindRestartPane(store, 'refused-stop', 'original-incarnation')
  const { condition } = beginHostRestart(store, pane, 'refused-stop', 'original-incarnation')
  const deps = rendererRestartDeps({ ...makeRuntimePtySpawnTestDeps(), store })
  const result = await runPtyIpcSpawn(deps, {
    ...pane,
    cols: 80,
    rows: 24,
    accountRestart: condition
  }).catch((error: unknown) => error)

  expect(accountRestartErrorReceipt(result)).toMatchObject({
    stop,
    current: { kind: 'original', incarnationId: 'original-incarnation' }
  })
})

it('sends the restart attempt to the provider despite a request to delete its environment key', async () => {
  const provider = localRestartProvider()
  const spawn = vi.spyOn(provider, 'spawn').mockResolvedValue({
    id: 'fresh-account-process',
    incarnationId: 'fresh-account-incarnation'
  })
  const { store } = await fixture()
  const args = await emptyRestartPane(store)
  await runPtyIpcSpawn(rendererRestartDeps({ ...makeRuntimePtySpawnTestDeps(), store }), {
    ...args,
    env: { ORCA_AGENT_LAUNCH_TOKEN: 'old-attempt', DROP_THIS: 'requested' },
    envToDelete: ['ORCA_AGENT_LAUNCH_TOKEN', 'DROP_THIS']
  })
  const launch = spawn.mock.calls[0]?.[0]
  expect(launch?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe('expected-attempt')
  expect(launch?.env?.DROP_THIS).toBeUndefined()
  expect(launch?.envToDelete).not.toContain('ORCA_AGENT_LAUNCH_TOKEN')
})

it('refuses to commit an existing provider session as a fresh account restart', async () => {
  const provider = localRestartProvider()
  const spawn = vi.spyOn(provider, 'spawn').mockResolvedValue({
    id: 'previous-account-process',
    incarnationId: 'previous-account-incarnation',
    isReattach: true
  })
  const { store } = await fixture()
  const args = await emptyRestartPane(store)
  const deps = rendererRestartDeps({ ...makeRuntimePtySpawnTestDeps(), store })

  await expect(
    runPtyIpcSpawn(deps, { ...args, sessionId: 'previous-account-process' })
  ).rejects.toThrow('invalid_account_restart')
  expect(spawn).not.toHaveBeenCalled()
  await expect(runPtyIpcSpawn(deps, args)).rejects.toThrow(
    'terminal_account_restart_outcome_unknown'
  )
  const layout = store.getWorkspaceSession().terminalLayoutsByTabId[tabId]
  expect(layout.ptyIdsByLeafId?.[TEST_LEAF_1]).toBeUndefined()
})

it('does not publish or shut down a replacement without an incarnation', async () => {
  const provider = localRestartProvider()
  vi.spyOn(provider, 'spawn').mockResolvedValue({ id: 'unproven-restart-pty' })
  const shutdown = vi.spyOn(provider, 'shutdown').mockResolvedValue(undefined)
  const { store } = await fixture()
  const args = await emptyRestartPane(store)

  const error = await runPtyIpcSpawn(
    rendererRestartDeps({ ...makeRuntimePtySpawnTestDeps(), store }),
    args
  ).catch((cause: unknown) => cause)

  expect(accountRestartErrorReceipt(error)).toMatchObject({ outcome: 'unknown' })
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBeUndefined()
  expect(shutdown).not.toHaveBeenCalled()
})

it('clears the stopped binding after a rejected replacement write restores it', async () => {
  const { store, authority } = await fixture()
  const pane = await bindRestartPane(store, 'stopped-owner', 'old-incarnation')
  const operation = beginHostRestart(store, pane, 'stopped-owner', 'old-incarnation')
  operation.stop = 'confirmed-retired'
  const stopped = replaced('stopped-owner')
  const result = { id: 'rejected-replacement', incarnationId: 'new-incarnation' }
  authority.failNextWrite()

  await expect(
    savePtySpawnPaneBinding(
      {
        accountRestartOperation: operation,
        result,
        provider: new LocalPtyProvider(),
        replacedPaneOwner: stopped,
        deps: {}
      },
      {
        store,
        binding: { ...pane, ptyId: result.id, incarnationId: result.incarnationId },
        refusal: 'terminal_pane_owner_changed',
        failureLog: 'rejected test replacement'
      },
      undefined
    )
  ).rejects.toMatchObject({ agentSessionOperationOutcome: 'unknown' })

  await expect(releaseStoppedPaneBinding(store, stopped, operation)).resolves.toBe(true)
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBeUndefined()
})

it('retries a confirmed retirement after both replacement and cleanup writes fail', async () => {
  const { store, authority } = await fixture()
  const oldId = 'twice-restored-retired-owner'
  const pane = await bindRestartPane(store, oldId, 'old-incarnation')
  const operation = beginHostRestart(store, pane, oldId, 'old-incarnation')
  operation.stop = 'confirmed-retired'
  const stopped = replaced(oldId)
  const result = { id: 'failed-first-replacement', incarnationId: 'first-incarnation' }
  authority.failNextWrite()
  await expect(
    savePtySpawnPaneBinding(
      {
        accountRestartOperation: operation,
        result,
        provider: new LocalPtyProvider(),
        replacedPaneOwner: stopped,
        deps: {}
      },
      {
        store,
        binding: { ...pane, ptyId: result.id, incarnationId: result.incarnationId },
        refusal: 'terminal_pane_owner_changed',
        failureLog: 'test replacement write'
      },
      undefined
    )
  ).rejects.toThrow()
  authority.failNextWrite()
  await expect(releaseStoppedPaneBinding(store, stopped, operation)).resolves.toBe(false)
  expect(accountRestartSnapshot(store, undefined, pane).owner).toEqual({
    ptyId: oldId,
    incarnationId: 'old-incarnation'
  })

  const priorProvider = getLocalPtyProvider()
  const adapter = new DaemonPtyAdapter({
    socketPath: 'unused-restart-socket',
    tokenPath: 'unused-restart-token',
    protocolVersion: PROTOCOL_VERSION
  })
  vi.spyOn(adapter, 'listProcesses').mockResolvedValue([])
  vi.spyOn(adapter, 'spawn').mockImplementation(async (opts) => ({
    id: opts.sessionId!,
    incarnationId: 'retry-incarnation'
  }))
  const checkedKill = vi
    .spyOn(adapter, 'killFenced')
    .mockRejectedValue(new Error('unexpected stop'))
  onTestFinished(() => adapter.dispose())
  setLocalPtyProvider(new DaemonPtyRouter({ current: adapter, legacy: [] }))
  onTestFinished(() => setLocalPtyProvider(priorProvider))
  const deps = rendererRestartDeps({ ...makeRuntimePtySpawnTestDeps(), store })
  const retry = await runPtyIpcSpawn(deps, {
    ...pane,
    cols: 80,
    rows: 24,
    accountRestart: {
      ...operation.condition,
      attemptId: 'retry-attempt',
      expected: {
        kind: 'endpoint',
        ptyId: oldId,
        incarnationId: 'old-incarnation',
        bindingGeneration: accountRestartSnapshot(store, undefined, pane).bindingGeneration
      }
    }
  })
  expect(retry.incarnationId).toBe('retry-incarnation')
  expect(accountRestartSnapshot(store, undefined, pane).owner?.ptyId).toBe(retry.id)
  expect(checkedKill).not.toHaveBeenCalled()
})

it('commits an SSH replacement to its authoritative partition when the local pane identity collides', async () => {
  const { store } = await fixture()
  const connectionId = 'account-restart-ssh'
  const hostId = toSshExecutionHostId(connectionId)
  const pane = { worktreeId, tabId, leafId: TEST_LEAF_1 }
  await admitRuntimeSpawnPane(store, pane, connectionId)
  await store.persistPtyBinding({ ...pane, ptyId: 'ssh-old', incarnationId: 'inc-ssh-old' }, hostId)
  await store.persistPtyBinding({ ...pane, ptyId: 'local-winner', incarnationId: 'inc-local' })
  await savePtySpawnPaneBinding(
    {
      result: { id: 'ssh-new', incarnationId: 'inc-ssh-new' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a successful durable swap never accesses the cleanup-only provider.
      provider: {} as never,
      replacedPaneOwner: { ptyId: 'ssh-old', pane: { ...pane, hostId } },
      deps: {}
    },
    {
      store,
      binding: { ...pane, ptyId: 'ssh-new', incarnationId: 'inc-ssh-new' },
      refusal: 'terminal_pane_owner_changed',
      failureLog: 'unexpected SSH commit failure'
    },
    connectionId
  )
  expect(
    store.getWorkspaceSession(hostId).terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBe('ssh-new')
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBe('local-winner')
})

it('reports an uncertain restart after a live binding commits but registration loses its claim', async () => {
  const provider = localRestartProvider()
  vi.spyOn(provider, 'spawn').mockResolvedValue({
    id: 'committed-restart-pty',
    incarnationId: 'committed-restart-incarnation'
  })
  const { store } = await fixture()
  const args = await emptyRestartPane(store)
  const runtime = new OrcaRuntimeService(store)
  const narrow = runtime.narrowPtyRegistration.bind(runtime)
  const boundPty = () =>
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  vi.spyOn(runtime, 'narrowPtyRegistration').mockImplementation((...authority) =>
    boundPty() === 'committed-restart-pty' ? false : narrow(...authority)
  )
  const deps = rendererRestartDeps({ ...makeRuntimePtySpawnTestDeps(), store, runtime })

  const result = await runPtyIpcSpawn(deps, args).catch((error: unknown) => error)

  expect(boundPty()).toBe('committed-restart-pty')
  expect(accountRestartErrorReceipt(result)).toMatchObject({
    requestId: 'request-new-account',
    attemptId: 'expected-attempt',
    stop: 'not-started',
    outcome: 'unknown'
  })
})
