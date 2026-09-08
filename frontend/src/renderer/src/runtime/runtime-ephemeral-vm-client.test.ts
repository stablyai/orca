import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc, subscribeRuntimeStreamChannel } from './runtime-rpc-client'
import type * as RuntimeRpcClientModule from './runtime-rpc-client'
import {
  listRuntimeEphemeralVmRecipes,
  listRuntimeEphemeralVmRecipeCatalog,
  provisionRuntimeEphemeralVmWorkspace,
  cancelRuntimeEphemeralVmProvision
} from './runtime-ephemeral-vm-client'

vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: vi.fn(),
  subscribeRuntimeStreamChannel: vi.fn()
}))

const callRuntimeRpcMock = vi.mocked(callRuntimeRpc)
const subscribeRuntimeStreamChannelMock = vi.mocked(subscribeRuntimeStreamChannel)

// target.kind === 'environment' whenever activeRuntimeEnvironmentId is set —
// see getActiveRuntimeTarget in runtime-rpc-client.ts.
const remoteSettings = { activeRuntimeEnvironmentId: 'env-1' }

const listRecipesLocal = vi.fn()
const listRecipeCatalogLocal = vi.fn()
const provisionLocal = vi.fn()
const cancelProvisionLocal = vi.fn()
const onProvisionEventLocal = vi.fn()

beforeEach(() => {
  callRuntimeRpcMock.mockReset()
  subscribeRuntimeStreamChannelMock.mockReset()
  listRecipesLocal.mockReset()
  listRecipeCatalogLocal.mockReset()
  provisionLocal.mockReset()
  cancelProvisionLocal.mockReset()
  onProvisionEventLocal.mockReset()
  vi.stubGlobal('window', {
    api: {
      ephemeralVm: {
        listRecipes: listRecipesLocal,
        listRecipeCatalog: listRecipeCatalogLocal,
        provision: provisionLocal,
        cancelProvision: cancelProvisionLocal,
        onProvisionEvent: onProvisionEventLocal
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// FE-TASK-EVM-001 audit finding: backend-go's ephemeralVm.listRecipes/
// listRecipeCatalog (channels_ephemeral_vm.go) send `diagnostics` as plain,
// pre-formatted strings (git-gateway-service's parseEnvironmentRecipes),
// not window.api.ephemeralVm's structured `{index, field?, message}` shape.
// These are round-trip tests against that REAL backend-go response shape —
// not the desktop-local shape, which listRecipesLocal/listRecipeCatalogLocal
// cover separately below.
describe('listRuntimeEphemeralVmRecipes', () => {
  it('routes to window.api.ephemeralVm.listRecipes for a local target, untouched', async () => {
    const localResult = {
      status: 'ok' as const,
      repoPath: '/repo',
      recipes: [],
      diagnostics: []
    }
    listRecipesLocal.mockResolvedValue(localResult)

    const result = await listRuntimeEphemeralVmRecipes(null, { repoId: 'repo-1' })

    expect(listRecipesLocal).toHaveBeenCalledWith({ repoId: 'repo-1' })
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
    expect(result).toBe(localResult)
  })

  it('normalizes backend-go plain-string diagnostics into {index, message} and backfills status: ok', async () => {
    // Real backend-go shape (channels_ephemeral_vm.go's ephemeralVm.listRecipes
    // handler): no `status`/`message` fields, `diagnostics` is []string with
    // the "environmentRecipes[N]: " prefix already baked in by
    // parseEnvironmentRecipes.
    callRuntimeRpcMock.mockResolvedValue({
      repoPath: '/repo',
      recipes: [{ id: 'r1', name: 'Recipe 1', create: 'docker run' }],
      diagnostics: ['environmentRecipes[2]: id and create are required, skipping']
    } as never)

    const result = await listRuntimeEphemeralVmRecipes(remoteSettings, { repoId: 'repo-1' })

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'ephemeralVm.listRecipes',
      { repoId: 'repo-1' }
    )
    expect(result.status).toBe('ok')
    expect(result.diagnostics).toEqual([
      { index: 2, message: 'id and create are required, skipping' }
    ])
  })

  it('falls back to the array index when a diagnostic string has no "environmentRecipes[N]:" prefix', async () => {
    // parseEnvironmentRecipes emits this prefix-less form for a YAML parse
    // failure (no single recipe index applies).
    callRuntimeRpcMock.mockResolvedValue({
      repoPath: '/repo',
      recipes: [],
      diagnostics: ['orca.yaml is not valid YAML: mapping values are not allowed here']
    } as never)

    const result = await listRuntimeEphemeralVmRecipes(remoteSettings, { repoId: 'repo-1' })

    expect(result.diagnostics).toEqual([
      { index: 0, message: 'orca.yaml is not valid YAML: mapping values are not allowed here' }
    ])
  })
})

describe('listRuntimeEphemeralVmRecipeCatalog', () => {
  it('routes to window.api.ephemeralVm.listRecipeCatalog for a local target, untouched', async () => {
    const localResult = [
      { repoId: 'r1', repoName: 'Repo 1', repoPath: '/r1', recipes: [], diagnostics: [] }
    ]
    listRecipeCatalogLocal.mockResolvedValue(localResult)

    const result = await listRuntimeEphemeralVmRecipeCatalog(null)

    expect(listRecipeCatalogLocal).toHaveBeenCalledWith()
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
    expect(result).toBe(localResult)
  })

  it("normalizes each catalog entry's backend-go plain-string diagnostics", async () => {
    callRuntimeRpcMock.mockResolvedValue([
      {
        repoId: 'r1',
        repoName: 'Repo 1',
        repoPath: '/r1',
        recipes: [],
        diagnostics: ['environmentRecipes[0]: id and create are required, skipping']
      }
    ] as never)

    const result = await listRuntimeEphemeralVmRecipeCatalog(remoteSettings)

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'ephemeralVm.listRecipeCatalog'
    )
    expect(result).toEqual([
      {
        repoId: 'r1',
        repoName: 'Repo 1',
        repoPath: '/r1',
        recipes: [],
        diagnostics: [{ index: 0, message: 'id and create are required, skipping' }]
      }
    ])
  })
})

// FE-TASK-EVM-003. window.api.ephemeralVm.provision is request/response
// (resolves with the FULL final result) — desktop's real streaming signal is
// the separate global onProvisionEvent broadcast, filtered by provisionId
// since it isn't scoped to one call (api-types.ts:2520-2549). These tests
// cover the local branch's adapter that normalizes that into the same
// {ack, unsubscribe} + onEvent(stream) contract the environment branch gets
// natively from subscribeRuntimeStreamChannel.
describe('provisionRuntimeEphemeralVmWorkspace', () => {
  it('local target: calls window.api.ephemeralVm.provision, forwards matching broadcast chunks, emits a result event, then auto-unsubscribes', async () => {
    let broadcastCallback: (event: {
      provisionId: string
      stream: 'stdout' | 'stderr'
      chunk: string
    }) => void = () => {}
    const unsubscribeBroadcastMock = vi.fn()
    onProvisionEventLocal.mockImplementation((callback) => {
      broadcastCallback = callback
      return unsubscribeBroadcastMock
    })
    let resolveProvision!: (value: unknown) => void
    provisionLocal.mockReturnValue(
      new Promise((resolve) => {
        resolveProvision = resolve
      })
    )

    const events: unknown[] = []
    const promise = provisionRuntimeEphemeralVmWorkspace(
      null,
      { repoId: 'repo-1', recipeId: 'recipe-1', workspaceName: 'ws', provisionId: 'prov-1' },
      (event) => events.push(event)
    )

    expect(provisionLocal).toHaveBeenCalledWith({
      repoId: 'repo-1',
      recipeId: 'recipe-1',
      workspaceName: 'ws',
      projectId: undefined,
      workspaceId: undefined,
      provisionId: 'prov-1'
    })
    const { ack, unsubscribe } = await promise
    expect(ack).toEqual({ provisionId: 'prov-1' })
    expect(typeof unsubscribe).toBe('function')

    // Broadcast event for a DIFFERENT provisionId must be ignored.
    broadcastCallback({ provisionId: 'other', stream: 'stdout', chunk: 'noise' })
    // Broadcast event for THIS provisionId must reach onEvent.
    broadcastCallback({ provisionId: 'prov-1', stream: 'stderr', chunk: 'building...' })
    expect(events).toEqual([{ type: 'stderr', chunk: 'building...' }])

    resolveProvision({
      ok: true,
      connectionType: 'ssh',
      runtime: { id: 'runtime-1' },
      sshTargetId: 'ssh-1',
      stderr: '',
      warnings: []
    })
    await vi.waitFor(() => {
      expect(events.some((e) => (e as { type: string }).type === 'result')).toBe(true)
    })
    expect(events.at(-1)).toEqual({
      type: 'result',
      result: {
        ok: true,
        connectionType: 'ssh',
        runtime: { id: 'runtime-1' },
        sshTargetId: 'ssh-1',
        stderr: '',
        warnings: []
      }
    })
    // provision() settling auto-unsubscribes the broadcast listener.
    expect(unsubscribeBroadcastMock).toHaveBeenCalledTimes(1)
  })

  it('local target: generates a provisionId when the caller does not supply one', async () => {
    onProvisionEventLocal.mockReturnValue(vi.fn())
    provisionLocal.mockResolvedValue({ ok: false, error: 'boom', stderr: '', stdout: '' })

    const { ack } = await provisionRuntimeEphemeralVmWorkspace(
      null,
      { repoId: 'repo-1', recipeId: 'recipe-1' },
      () => {}
    )

    expect(ack.provisionId).toBeTruthy()
    expect(provisionLocal).toHaveBeenCalledWith(
      expect.objectContaining({ provisionId: ack.provisionId })
    )
  })

  it('local target: emits an error event when provision() resolves ok:false', async () => {
    onProvisionEventLocal.mockReturnValue(vi.fn())
    provisionLocal.mockResolvedValue({ ok: false, error: 'recipe failed', stderr: '', stdout: '' })

    const events: unknown[] = []
    await provisionRuntimeEphemeralVmWorkspace(
      null,
      { repoId: 'repo-1', recipeId: 'recipe-1', provisionId: 'prov-2' },
      (event) => events.push(event)
    )
    await vi.waitFor(() => {
      expect(events).toEqual([{ type: 'error', error: 'recipe failed' }])
    })
  })

  it('local target: rejects without calling window.api.ephemeralVm.provision when repoId is missing', async () => {
    await expect(
      provisionRuntimeEphemeralVmWorkspace(null, { recipeId: 'recipe-1' }, () => {})
    ).rejects.toThrow(/repoId/)
    expect(provisionLocal).not.toHaveBeenCalled()
  })

  it('local target: unsubscribe() stops further onEvent delivery', async () => {
    let broadcastCallback: (event: {
      provisionId: string
      stream: 'stdout' | 'stderr'
      chunk: string
    }) => void = () => {}
    onProvisionEventLocal.mockImplementation((callback) => {
      broadcastCallback = callback
      return vi.fn()
    })
    provisionLocal.mockReturnValue(new Promise(() => {})) // never resolves in this test

    const events: unknown[] = []
    const { unsubscribe } = await provisionRuntimeEphemeralVmWorkspace(
      null,
      { repoId: 'repo-1', recipeId: 'recipe-1', provisionId: 'prov-3' },
      (event) => events.push(event)
    )
    unsubscribe()
    broadcastCallback({ provisionId: 'prov-3', stream: 'stdout', chunk: 'after unsubscribe' })
    expect(events).toEqual([])
  })

  it('environment target: routes to subscribeRuntimeStreamChannel with the backend-go wire args', async () => {
    const onEvent = vi.fn()
    const ackResult = { ack: { provisionId: 'prov-4' }, unsubscribe: vi.fn() }
    subscribeRuntimeStreamChannelMock.mockResolvedValue(ackResult)

    const result = await provisionRuntimeEphemeralVmWorkspace(
      remoteSettings,
      { connectionId: 'conn-1', recipeId: 'recipe-1', runtimeId: 'runtime-1' },
      onEvent
    )

    expect(subscribeRuntimeStreamChannelMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'ephemeralVm.provision',
      { connectionId: 'conn-1', recipeId: 'recipe-1', runtimeId: 'runtime-1' },
      onEvent
    )
    expect(result).toBe(ackResult)
    expect(provisionLocal).not.toHaveBeenCalled()
  })

  it('environment target: rejects without calling subscribeRuntimeStreamChannel when connectionId/runtimeId are missing', async () => {
    await expect(
      provisionRuntimeEphemeralVmWorkspace(remoteSettings, { recipeId: 'recipe-1' }, () => {})
    ).rejects.toThrow(/connectionId and runtimeId/)
    expect(subscribeRuntimeStreamChannelMock).not.toHaveBeenCalled()
  })

  // TASK-BE-EVM-005 has shipped: channels_ephemeral_vm.go's
  // registerEphemeralVmProvisionChannel now calls r.RegisterStreamChannel(
  // "ephemeralVm.provision", ...). Per this task's audit step, the frontend
  // test suite has NO precedent of a test connecting to a real backend-go
  // process/transport (see runtime-rpc-client.test.ts's own integration
  // test comment for the full audit trail) — there is no cross-process
  // harness to plug into here.
  //
  // This is the fullest test possible within that constraint: it swaps
  // subscribeRuntimeStreamChannel back to its REAL implementation (this
  // file's top-level vi.mock replaces it with a bare vi.fn() for every other
  // test in this file) and drives the whole chain —
  // provisionRuntimeEphemeralVmWorkspace -> subscribeRuntimeStreamChannel ->
  // window.api.runtimeEnvironments.subscribe -> onEvent — against the
  // CONFIRMED real wire shapes backend-go emits for this channel (ack =
  // ephemeralVmProvisionAckView's {"provisionId"}; push events =
  // pipePushForDialect's SessionClientResultMessage{streaming:true, result:
  // toEphemeralVmProvisionEventView(...)}, channels_ephemeral_vm.go/
  // push_bridge.go — same shapes runtime-rpc-client.test.ts's own
  // integration test verifies one layer down).
  it('environment target: integration — real subscribeRuntimeStreamChannel demuxes the confirmed ephemeralVm.provision wire shape', async () => {
    const actual = await vi.importActual<typeof RuntimeRpcClientModule>('./runtime-rpc-client')
    subscribeRuntimeStreamChannelMock.mockImplementation(actual.subscribeRuntimeStreamChannel)

    type SubscribeCallbacks = { onResponse: (response: unknown) => void }
    // Why: a plain `let` reassigned only inside the mock's callback narrows
    // to `never` at the read sites below under TS's control-flow analysis —
    // routing the assignment through a boxed object sidesteps that.
    const subscription: { callbacks: SubscribeCallbacks | null } = { callbacks: null }
    const runtimeEnvironmentsSubscribe = vi.fn((_args: unknown, cb: SubscribeCallbacks) => {
      subscription.callbacks = cb
      return Promise.resolve({ unsubscribe: vi.fn(), sendBinary: vi.fn() })
    })
    // Re-stub window with the same ephemeralVm.* mocks beforeEach already
    // wired up, plus the runtimeEnvironments.subscribe hook the real
    // subscribeRuntimeStreamChannel implementation needs (absent from the
    // module-level stub since every other test keeps subscribeRuntimeStreamChannel mocked).
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: {
          listRecipes: listRecipesLocal,
          listRecipeCatalog: listRecipeCatalogLocal,
          provision: provisionLocal,
          cancelProvision: cancelProvisionLocal,
          onProvisionEvent: onProvisionEventLocal
        },
        runtimeEnvironments: { subscribe: runtimeEnvironmentsSubscribe }
      }
    })

    const events: unknown[] = []
    const promise = provisionRuntimeEphemeralVmWorkspace(
      remoteSettings,
      { connectionId: 'conn-1', recipeId: 'recipe-1', runtimeId: 'runtime-1' },
      (event) => events.push(event)
    )

    expect(runtimeEnvironmentsSubscribe).toHaveBeenCalledWith(
      {
        selector: 'env-1',
        method: 'ephemeralVm.provision',
        params: { connectionId: 'conn-1', recipeId: 'recipe-1', runtimeId: 'runtime-1' }
      },
      expect.any(Object)
    )

    subscription.callbacks?.onResponse({
      id: 'req-1',
      ok: true,
      result: { provisionId: 'prov-live' },
      _meta: { runtimeId: 'rt-1' }
    })
    const { ack, unsubscribe } = await promise
    expect(ack).toEqual({ provisionId: 'prov-live' })

    subscription.callbacks?.onResponse({
      id: 'req-1',
      ok: true,
      streaming: true,
      result: { provisionId: 'prov-live', type: 'stdout', chunk: 'pulling image...' },
      _meta: { runtimeId: 'rt-1' }
    })
    subscription.callbacks?.onResponse({
      id: 'req-1',
      ok: true,
      streaming: true,
      result: {
        provisionId: 'prov-live',
        type: 'result',
        result: { type: 'orca-server', projectRoot: '/vm/repo', pairingCode: 'abc-123' }
      },
      _meta: { runtimeId: 'rt-1' }
    })

    expect(events).toEqual([
      { provisionId: 'prov-live', type: 'stdout', chunk: 'pulling image...' },
      {
        provisionId: 'prov-live',
        type: 'result',
        result: { type: 'orca-server', projectRoot: '/vm/repo', pairingCode: 'abc-123' }
      }
    ])

    unsubscribe()
    subscription.callbacks?.onResponse({
      id: 'req-1',
      ok: true,
      streaming: true,
      result: { provisionId: 'prov-live', type: 'stdout', chunk: 'after unsubscribe' },
      _meta: { runtimeId: 'rt-1' }
    })
    expect(events).toHaveLength(2)
  })
})

describe('cancelRuntimeEphemeralVmProvision', () => {
  it('local target: routes to window.api.ephemeralVm.cancelProvision({ provisionId })', async () => {
    cancelProvisionLocal.mockResolvedValue({ cancelled: true })

    const result = await cancelRuntimeEphemeralVmProvision(null, 'prov-1')

    expect(cancelProvisionLocal).toHaveBeenCalledWith({ provisionId: 'prov-1' })
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
    expect(result).toEqual({ cancelled: true })
  })

  it('environment target: routes to callRuntimeRpc(target, "ephemeralVm.cancelProvision", { provisionId })', async () => {
    callRuntimeRpcMock.mockResolvedValue({ cancelled: false })

    const result = await cancelRuntimeEphemeralVmProvision(remoteSettings, 'prov-2')

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'ephemeralVm.cancelProvision',
      { provisionId: 'prov-2' }
    )
    expect(cancelProvisionLocal).not.toHaveBeenCalled()
    expect(result).toEqual({ cancelled: false })
  })
})
