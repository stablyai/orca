import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  createRestTestRig,
  foundRestTestChat,
  IDLE_MS,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  hostTestAttachParams,
  hostTestOperationId,
  HOST_TEST_THREAD
} from './structured-agent-session-host-test-data'
import * as loginShell from '../../startup/login-shell-environment'
import { createStructuredAgentEnvironmentResolvers } from '../../runtime/structured-agent-shell-environment'
import { codexModelCatalogDiscovery } from '../../runtime/structured-agent-model-catalog-discovery'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { retireAtRestCommandContext } from './at-rest-command-context'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import { structuredAgentSessionPermissionDescriptor } from '../../../shared/structured-agent-session-permission-option'

describe('a chat permission mode', () => {
  let rig: RestTestRig

  beforeEach(async () => {
    rig = await createRestTestRig()
  })

  afterEach(async () => {
    await rig.dispose()
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
  const pick = (value: string, key = 'permissionMode') => {
    const fields = { key, value }
    return rig.host.setOption(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: fence(),
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: SESSION,
          fields
        })
      },
      ...fields
    })
  }

  it('starts a chat saved before modes existed as Ask, and reads it back as Ask', async () => {
    await foundRestTestChat(rig)
    expect(rig.adapter.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'ask' })
    )
    expect((await rig.host.readOptions(SESSION)).current.permissionMode).toBe('ask')
  })

  it.each([true, false, undefined])(
    'keeps saved Auto independent of cold catalog support=%s and explicit preparation',
    async (supportsAutoMode) => {
      const home = { variable: 'CLAUDE_CONFIG_DIR', path: '/saved-auto-account' }
      const key = agentModelCatalogScopeFingerprint(
        agentModelCatalogFingerprint({ agent: 'claude', accountHome: home, wslDistro: null }),
        '/project',
        'saved-launch'
      )
      const seed = new AgentModelCatalogStore()
      const saved = seed.recordSuccess(
        key,
        'claude',
        {
          origin: 'probe',
          models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsAutoMode }]
        },
        'discovery'
      )!
      const store = new AgentModelCatalogStore()
      const persist = vi.fn()
      await store.attachPersistence({
        load: async () => (supportsAutoMode === undefined ? [] : [saved]),
        save: persist,
        flush: async () => {}
      })
      const run = vi.fn(async () => {
        throw new Error('options display must not list models')
      })
      const resolve = vi.fn(async () => ({ identity: 'saved-launch', run }))
      const workspace = vi.fn(async () => '/project')
      const account = vi.fn(async () => home)
      const catalog = createAgentModelCatalogService({
        store,
        getRecord: (id) => rig.store.getRecord(id) ?? undefined,
        getConversation: (id) => rig.store.getConversation(id) ?? undefined,
        drivesRecord: () => true,
        recordWorkspacePath: workspace,
        resolveAccountHome: account,
        probes: { claude: Object.assign(vi.fn(run), { resolve }) }
      })
      const prepare = vi.spyOn(catalog, 'prepareSaved')
      const ingest = vi.spyOn(store, 'recordSuccess')
      const defaults = vi.spyOn(store, 'recordConfiguredDefault')
      const acquire = rig.adapter.acquire.getMockImplementation()!
      rig.adapter.acquire.mockImplementation(async (input) => {
        const acquired = await acquire(input)
        return {
          ...acquired,
          ...(acquired.link
            ? { link: { ...acquired.link, handle: claudeProviderHandle(HOST_TEST_THREAD, null) } }
            : {})
        }
      })
      rig.adapter.dispatch.mockResolvedValue({
        state: 'accepted',
        providerIdentity: { provider: 'claude', sessionId: HOST_TEST_THREAD, uuid: 'reply' }
      })
      const seedCatalog = getAgentSessionOptionCatalog('claude')!
      const read = async (mode: 'auto' | 'ask') => {
        const answer = await rig.host.readOptions(SESSION, { readsWithoutModel: true })
        expect(answer.current.permissionMode).toBe(mode)
        const state = applyStructuredAgentSessionOptions(
          createStructuredAgentSessionOptionState('claude'),
          seedCatalog,
          answer
        )
        expect(structuredAgentSessionPermissionDescriptor(state)?.kind).toMatchObject({
          type: 'select',
          currentValue: mode
        })
      }
      try {
        const attached = await rig.host.attach(
          CALLER,
          hostTestAttachParams(null, {
            provider: 'claude',
            agent: 'claude',
            accountHome: home,
            providerHandle: { kind: 'claude', sessionId: HOST_TEST_THREAD, leafUuid: null },
            options: { model: 'opus', permissionMode: 'auto' }
          })
        )
        expect(attached.ok, JSON.stringify(attached)).toBe(true)
        expect(rig.adapter.acquire).toHaveBeenLastCalledWith(
          expect.objectContaining({ permissionMode: 'auto' })
        )
        await rig.restart({ modelCatalog: catalog })
        await read('auto')
        await read('auto')
        for (const work of [prepare, resolve, workspace, account, run, ingest, defaults, persist]) {
          expect(work).not.toHaveBeenCalled()
        }
        expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
        await catalog.prepareSaved({
          agent: 'claude',
          sessionId: SESSION,
          inSessionWorkspace: true
        })
        const fence = () => rig.store.getRecord(SESSION)!.lease.runtimeFence
        expect((await rig.host.send(CALLER, restTestSend('prepared start', fence()))).ok).toBe(true)
        await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1))
        expect(rig.adapter.acquire).toHaveBeenLastCalledWith(
          expect.objectContaining({ permissionMode: 'auto' })
        )
        expect(prepare).toHaveBeenCalled()
        expect(resolve).toHaveBeenCalledOnce()
        prepare.mockClear()
        await read('auto')
        expect(prepare).not.toHaveBeenCalled()
        rig.adapter.closeSession.mockClear()
        expect((await rig.host.send(CALLER, restTestSend('outgrown comparison', fence()))).ok).toBe(
          true
        )
        await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
        expect(prepare).not.toHaveBeenCalled()
        expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
        expect(rig.adapter.closeSession).not.toHaveBeenCalled()
        expect(run).not.toHaveBeenCalled()
        expect(rig.store.getRecord(SESSION)?.permissionMode).toBe('auto')
      } finally {
        catalog.stop()
      }
    }
  )

  it('acquires cold saved Auto and keeps that child after an unrelated folder retires', async () => {
    const home = { variable: 'CLAUDE_CONFIG_DIR', path: '/saved-auto-account' }
    const key = agentModelCatalogScopeFingerprint(
      agentModelCatalogFingerprint({ agent: 'claude', accountHome: home, wslDistro: null }),
      '/project',
      'saved-launch'
    )
    const seed = new AgentModelCatalogStore()
    const saved = seed.recordSuccess(
      key,
      'claude',
      {
        origin: 'probe',
        models: [
          { id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsAutoMode: true }
        ]
      },
      'discovery'
    )!
    const store = new AgentModelCatalogStore()
    await store.attachPersistence({
      load: async () => [saved],
      save: () => {},
      flush: async () => {}
    })
    const pending = Promise.withResolvers<never>()
    const run = vi.fn(() => pending.promise)
    const resolve = vi.fn(async () => ({ identity: 'saved-launch', run }))
    const probe = Object.assign(vi.fn(run), { resolve })
    const catalog = createAgentModelCatalogService({
      store,
      getRecord: (id) => rig.store.getRecord(id) ?? undefined,
      getConversation: (id) => rig.store.getConversation(id) ?? undefined,
      drivesRecord: () => true,
      recordWorkspacePath: async () => '/project',
      resolveAccountHome: async () => home,
      probes: { claude: probe }
    })
    const acquire = rig.adapter.acquire.getMockImplementation()!
    rig.adapter.acquire.mockImplementation(async (input) => {
      const acquired = await acquire(input)
      return {
        ...acquired,
        ...(acquired.link
          ? { link: { ...acquired.link, handle: claudeProviderHandle(HOST_TEST_THREAD, null) } }
          : {})
      }
    })
    rig.adapter.dispatch.mockResolvedValue({
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: HOST_TEST_THREAD, uuid: 'reply' }
    })
    try {
      await rig.restart({ modelCatalog: catalog })
      const attached = await rig.host.attach(
        CALLER,
        hostTestAttachParams(null, {
          provider: 'claude',
          agent: 'claude',
          accountHome: home,
          providerHandle: { kind: 'claude', sessionId: HOST_TEST_THREAD, leafUuid: null },
          options: { model: 'opus', permissionMode: 'auto' }
        })
      )
      expect(attached.ok, JSON.stringify(attached)).toBe(true)
      expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
      expect(rig.adapter.acquire).toHaveBeenLastCalledWith(
        expect.objectContaining({ permissionMode: 'auto' })
      )
      expect(resolve).not.toHaveBeenCalled()
      await catalog.prepareSaved({ agent: 'claude', sessionId: SESSION, inSessionWorkspace: true })
      expect(resolve).toHaveBeenCalledWith(
        home,
        '/project',
        'saved',
        expect.objectContaining({
          deadline: expect.any(Number),
          current: expect.any(Function),
          signal: expect.any(AbortSignal)
        })
      )
      expect(run).not.toHaveBeenCalled()
      await rig.host.send(CALLER, restTestSend('first', fence()))
      await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1))
      void catalog.demand({ agent: 'claude', sessionId: SESSION, inSessionWorkspace: true })
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
      rig.adapter.closeSession.mockClear()
      const resolutions = resolve.mock.calls.length
      retireAtRestCommandContext('unrelated-folder')
      expect((await rig.host.send(CALLER, restTestSend('after retirement', fence()))).ok).toBe(true)
      await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
      expect(rig.adapter.closeSession).not.toHaveBeenCalled()
      expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledTimes(resolutions)
      expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.permissionMode).toBe(
        'auto'
      )
    } finally {
      catalog.stop()
    }
  })

  it('writes a pick to the record only, with the agent running', async () => {
    await foundRestTestChat(rig)
    const setOption = vi.spyOn(rig.host.deps.adapter, 'setOption')

    expect(await pick('full-access')).toMatchObject({
      ok: true,
      value: { options: { permissionMode: 'full-access' } }
    })
    expect(setOption).not.toHaveBeenCalled()
    expect(rig.store.getRecord(SESSION)?.permissionMode).toBe('full-access')
    expect((await rig.host.readOptions(SESSION)).current.permissionMode).toBe('full-access')
    expect(rig.host.readStatusSummary(SESSION)?.permissionMode).toBe('full-access')
  })

  it('records a pick at rest with the host clock without starting an agent', async () => {
    await foundRestTestChat(rig)
    rig.clock.now += IDLE_MS + 1
    await vi.waitFor(() => expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released'))
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeUndefined()
    rig.clock.now += 123
    const pickedAt = rig.clock.now
    const setOption = vi.spyOn(rig.host.deps.adapter, 'setOption')

    expect(await pick('full-access')).toMatchObject({
      ok: true,
      value: { options: { permissionMode: 'full-access' } }
    })
    expect(rig.store.getRecord(SESSION)).toMatchObject({
      permissionMode: 'full-access',
      updatedAt: pickedAt
    })
    expect(setOption).not.toHaveBeenCalled()
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
    await rig.restart()
    expect((await rig.host.readOptions(SESSION)).current.permissionMode).toBe('full-access')
  })

  it('saves a permission pick with a missing CLI without starting a shell capture', async () => {
    await foundRestTestChat(rig)
    const shellReady = Promise.withResolvers<NodeJS.ProcessEnv>()
    const shell = vi.fn(() => shellReady.promise)
    const resolveShell = loginShell.resolveLoginShellEnvironment
    const capture = vi
      .spyOn(loginShell, 'resolveLoginShellEnvironment')
      .mockImplementation((options) =>
        resolveShell({
          ...options,
          shellOverride: '/missing/catalog-shell',
          env: {},
          spawner: shell
        })
      )
    const environment = createStructuredAgentEnvironmentResolvers({})
    shell.mockClear()
    capture.mockClear()
    const discovery = codexModelCatalogDiscovery({
      environment,
      deps: {
        stateDirectory: rig.root,
        hostId: 'local',
        claimKeyId: 'key-1',
        resolveWorkspacePath: async () => rig.root,
        resolveLaunchArgs: () => [],
        resolveClaudeAuthPolicy: () => ({ account: 'system' }),
        resolveCodexCommand: () => 'codex-pr-30107-missing',
        logger: { warn: vi.fn(), error: vi.fn() }
      }
    })
    if (discovery.kind !== 'probe') {
      throw new Error('Codex must have discovery')
    }
    const catalog = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getConversation: (id) => rig.store.getConversation(id) ?? undefined,
      getRecord: (id) => rig.store.getRecord(id) ?? undefined,
      drivesRecord: () => true,
      recordWorkspacePath: async () => rig.root,
      resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/account' }),
      probes: { codex: discovery.probe }
    })
    try {
      await rig.restart({ modelCatalog: catalog })
      expect(await pick('full-access')).toMatchObject({
        ok: true,
        value: { options: { permissionMode: 'full-access' } }
      })
      expect(rig.store.getRecord(SESSION)?.permissionMode).toBe('full-access')
      shellReady.resolve({ PATH: '/missing/catalog-bin' })
      await environment.resolveBaseEnvironment()
      capture.mockClear()
      expect(await pick('ask')).toMatchObject({ ok: true })
      expect(capture).not.toHaveBeenCalled()
      expect(shell).not.toHaveBeenCalled()
    } finally {
      shellReady.resolve({ PATH: '/missing/catalog-bin' })
      catalog.stop()
      capture.mockRestore()
      loginShell.resetLoginShellEnvironmentCacheForTests()
    }
  })

  it('keeps Full access through a model pick on the running agent and the next start', async () => {
    await foundRestTestChat(rig)
    await pick('full-access')
    expect((await rig.host.send(CALLER, restTestSend('on full access', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))

    expect(await pick('gpt-picked', 'model')).toMatchObject({ ok: true })
    await rig.restart()
    expect((await rig.host.send(CALLER, restTestSend('after relaunch', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: 'full-access' })
    )
    expect(rig.host.readStatusSummary(SESSION)?.permissionMode).toBe('full-access')
  })

  it('refuses a mode the agent does not offer', async () => {
    await foundRestTestChat(rig)
    expect(await pick('accept-edits')).toMatchObject({ ok: false })
    expect(await pick('bypassPermissions')).toMatchObject({ ok: false })
    expect(rig.store.getRecord(SESSION)?.permissionMode).toBeUndefined()
  })

  it('starts a new agent with the new mode for the next send, and keeps it after', async () => {
    await foundRestTestChat(rig)
    rig.adapter.closeSession.mockClear()
    await pick('auto')

    expect((await rig.host.send(CALLER, restTestSend('after the change', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(rig.adapter.acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: 'auto' })
    )

    expect((await rig.host.send(CALLER, restTestSend('and again', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(3))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  })

  it('keeps the running agent for a send while its reply runs', async () => {
    await foundRestTestChat(rig)
    rig.adapter.closeSession.mockClear()
    const holds = rig.adapter.holdsDispatch.mockReturnValue(true)
    await pick('full-access')

    expect((await rig.host.send(CALLER, restTestSend('mid-reply', fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
    holds.mockReturnValue(false)
  })
})
