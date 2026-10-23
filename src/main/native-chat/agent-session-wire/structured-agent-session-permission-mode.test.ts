// A chat's permission mode is the record's: a pick writes only the record, even with the agent
// running, and the next send after a change goes to an agent started with the new mode.

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
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import * as loginShell from '../../startup/login-shell-environment'
import { createStructuredAgentEnvironmentResolvers } from '../../runtime/structured-agent-shell-environment'
import { codexModelCatalogDiscovery } from '../../runtime/structured-agent-model-catalog-discovery'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'

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
      expect(capture).toHaveBeenCalled()
      expect(capture.mock.calls.every(([options]) => options?.cachedOnly === true)).toBe(true)
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
    // Codex has no edits-only mode.
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
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION)
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
