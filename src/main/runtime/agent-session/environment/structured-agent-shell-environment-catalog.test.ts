import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentModelCatalogStore } from '../../../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprintForRecord } from '../../../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from '../../../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  captureHostShellEnvironment,
  createStructuredAgentEnvironmentResolvers
} from './structured-agent-shell-environment'

const shell = vi.hoisted(
  (): {
    current: { PATH: string; IGNORED: string }
    next: { PATH: string; IGNORED: string }
    saved: string[]
    nextSaved: string[]
  } => ({
    current: { PATH: '/a', IGNORED: 'a' },
    next: { PATH: '/a', IGNORED: 'a' },
    saved: [],
    nextSaved: []
  })
)
vi.mock('../../../startup/shell-environment/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async (options?: { startedAfter?: number }) => {
    if (options?.startedAfter !== undefined) {
      shell.current = { ...shell.next }
    }
    return { ...shell.current }
  }
}))
vi.mock('../../../pty/environment/windows-environment-path', () => ({
  cachedPersistedWindowsPathSegments: () => shell.saved,
  readPersistedWindowsPathSegmentsAsync: async () => (shell.saved = [...shell.nextSaved]),
  mergePersistedWindowsPathAsync: async () => {}
}))

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  shell.current = { PATH: '/a', IGNORED: 'a' }
  shell.next = { ...shell.current }
  shell.saved = []
  shell.nextSaved = []
})

function rig(overlay?: Record<string, string>) {
  const record = {
    ...agentSessionRecordFixture(),
    provider: 'grok',
    accountHome: { variable: 'GROK_HOME', path: '/catalog-refresh-fixture' }
  }
  const save = vi.fn()
  const defaults = vi.fn(async () => false)
  const service = createAgentModelCatalogService({
    store: agentModelCatalogStore,
    getConversation: (id) => {
      const held = id === record.sessionId ? record : undefined
      return held ? agentSessionConversationView(held) : undefined
    },
    getRecord: (id) => (id === record.sessionId ? record : undefined),
    drivesRecord: () => true,
    resolveAccountHome: async () => record.accountHome,
    recordWorkspacePath: async () => '/workspace',
    workspaceMayOverrideDefaultModel: defaults
  })
  const environment = createStructuredAgentEnvironmentResolvers({
    resolveShellEnvironmentPolicy: () => ({ inheritAll: false, names: [] }),
    resolveAgentLaunchEnv: () => overlay ?? {}
  })
  cleanups.push(service.stop, environment.bindCatalogSources(['grok']))
  const listing = (id: string) => ({
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    configuredDefault: { modelId: id, effort: 'high' }
  })
  return {
    record,
    service,
    save,
    defaults,
    listing,
    fingerprint: agentModelCatalogFingerprintForRecord(record)
  }
}

it('keeps a Windows catalog source while only a shadowed inherited path changes', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const overlay = { path: '/configured/bin' }
  const h = rig(overlay)
  const source = h.service.captureSource(h.record)
  cleanups.push(() => source.release?.())
  await captureHostShellEnvironment(async () => {
    shell.next = { PATH: '/changed', IGNORED: 'a' }
  })
  expect(source()).toBe(true)
  await captureHostShellEnvironment(async () => {
    overlay.path = '/new-configured/bin'
  })
  expect(source()).toBe(false)
})

it('retires a producer on effective Refresh before new publication and fences late defaults and new old reports', async () => {
  const h = rig()
  await agentModelCatalogStore.attachPersistence({
    load: async () => [],
    save: h.save,
    flush: async () => {}
  })
  const sourceA = h.service.captureSource(h.record)
  cleanups.push(() => sourceA.release?.())
  const heldDefault = Promise.withResolvers<boolean>()
  h.defaults.mockReturnValueOnce(heldDefault.promise)
  h.service.recordLiveListing(h.record.sessionId, h.listing('A'), sourceA)
  await vi.waitFor(() => expect(h.defaults).toHaveBeenCalledOnce())
  await captureHostShellEnvironment(async () => {
    shell.next = { PATH: '/b', IGNORED: 'a' }
  })
  expect(sourceA()).toBe(false)
  const sourceB = h.service.captureSource(h.record)
  cleanups.push(() => sourceB.release?.())
  h.service.recordLiveListing(h.record.sessionId, h.listing('B'), sourceB)
  await vi.waitFor(() => expect(agentModelCatalogStore.get(h.fingerprint)?.models[0]?.id).toBe('B'))
  const configured = vi.spyOn(agentModelCatalogStore, 'recordConfiguredDefault')
  heldDefault.resolve(false)
  await vi.waitFor(() =>
    expect(agentModelCatalogStore.get(h.fingerprint)?.configured?.modelId).toBe('B')
  )
  expect(configured.mock.calls.map((call) => call[1])).toEqual([{ modelId: 'B', effort: 'high' }])
  configured.mockClear()
  const before = JSON.stringify(agentModelCatalogStore.get(h.fingerprint))
  const writes = h.save.mock.calls.length
  const ingested = vi.spyOn(agentModelCatalogStore, 'recordSuccess')
  await agentModelCatalogStore.refresh(h.fingerprint, 'grok', () =>
    Promise.reject(new Error('current failure'))
  )
  h.service.recordLiveListing(h.record.sessionId, h.listing('late A'), sourceA)
  h.service.providerStarted(h.record, sourceA)
  await vi.waitFor(() => expect(h.defaults).toHaveBeenCalledTimes(2))
  await Promise.resolve()
  expect(ingested).not.toHaveBeenCalled()
  expect(configured).not.toHaveBeenCalled()
  expect(JSON.stringify(agentModelCatalogStore.get(h.fingerprint))).toBe(before)
  expect(agentModelCatalogStore.failureDetail(h.fingerprint)).toBe('current failure')
  expect(h.save).toHaveBeenCalledTimes(writes)
})

it.each([true, false])(
  'keeps the agent session that launched Orca out of a chat agent environment (inherit shell: %s)',
  async (inheritAll) => {
    const parentSession = { CODEX_THREAD_ID: 'parent-thread', CODEX_WINDOWS_REGISTERED_CORE: '1' }
    const resolvers = createStructuredAgentEnvironmentResolvers({
      prewarm: false,
      processEnvironment: { PATH: '/a', CODEX_HOME: '/home/user/.codex', ...parentSession },
      resolveEnvironment: async () => ({
        PATH: '/a',
        CODEX_HOME: '/home/user/.codex',
        ...parentSession
      }),
      resolveShellEnvironmentPolicy: () => ({ inheritAll, names: [] }),
      resolveAgentLaunchEnv: () => ({ CODEX_CI: 'set-by-user' })
    })
    const env = await resolvers.resolveAgentEnvironment('codex')
    expect(env.CODEX_THREAD_ID).toBeUndefined()
    expect(env.CODEX_WINDOWS_REGISTERED_CORE).toBeUndefined()
    expect(env.CODEX_HOME).toBe('/home/user/.codex')
    expect(env.CODEX_CI).toBe('set-by-user')
  }
)
