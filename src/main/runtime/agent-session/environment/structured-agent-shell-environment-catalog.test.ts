import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { resolveCliCommand } from '../../../../shared/node-cli-command-resolution'
import { createCodexModelCatalogProbe } from '../../../codex/structured/catalog/codex-model-catalog-probe'
import { refreshAtRestCommandContext } from '../../../native-chat/agent-session-wire/options/at-rest-command-context'
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
    current: { PATH: string; Path?: string; path?: string; IGNORED: string }
    next: { PATH: string; Path?: string; path?: string; IGNORED: string }
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
    resolveShellEnvironmentPolicy: () => ({ inheritAll: false, names: ['IGNORED'] }),
    resolveAgentLaunchEnv: () => overlay ?? {}
  })
  cleanups.push(service.stop, environment.bindCatalogSources(['grok']))
  const listing = (id: string) => ({
    origin: 'probe' as const,
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

it.each(['darwin', 'win32'] as const)(
  'keeps a %s catalog source through PATH-only and overlay-shadowed changes',
  async (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    shell.current = { PATH: '/a', Path: '/shadow-a', path: '/shadow-b', IGNORED: 'a' }
    const overlay = { IGNORED: 'configured' }
    const h = rig(overlay)
    const source = h.service.captureSource(h.record)
    cleanups.push(() => source.release?.())
    agentModelCatalogStore.recordSuccess(h.fingerprint, 'grok', h.listing('saved'), 'discovery')
    const held = Promise.withResolvers<ReturnType<typeof h.listing>>()
    const flight = agentModelCatalogStore.refresh(h.fingerprint, 'grok', () => held.promise)
    await Promise.resolve()
    await captureHostShellEnvironment(async () => {
      shell.next = {
        PATH: '/changed',
        Path: '/other-shadow-a',
        path: '/other-shadow-b',
        IGNORED: 'shadowed'
      }
    })
    expect(source()).toBe(true)
    expect(agentModelCatalogStore.get(h.fingerprint)?.models[0]?.id).toBe('saved')
    held.resolve(h.listing('current'))
    await flight
    expect(agentModelCatalogStore.get(h.fingerprint)?.models[0]?.id).toBe('current')
    await captureHostShellEnvironment(async () => {
      overlay.IGNORED = 'new-configured'
    })
    expect(source()).toBe(false)
  }
)

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
    shell.next = { PATH: '/b', IGNORED: 'b' }
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

it('reuses the selected Codex across folders and capture, then follows a different PATH executable', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-capture-'))
  const [a, b, bin, replacement, unrelated] = ['a', 'b', 'bin', 'replacement', 'unrelated'].map(
    (name) => join(folder, name)
  )
  await Promise.all([a, b, bin, replacement, unrelated].map((path) => mkdir(path)))
  const executable = process.platform === 'win32' ? 'catalog-codex.cmd' : 'catalog-codex'
  await Promise.all(
    [bin, replacement].map((path) =>
      writeFile(join(path, executable), 'test binary identity', { mode: 0o755 })
    )
  )
  shell.current = {
    PATH: `../bin${delimiter}./node_modules/.bin${delimiter}${folder}/unused-one${delimiter}`,
    IGNORED: 'a'
  }
  shell.next = { ...shell.current }
  const environment = createStructuredAgentEnvironmentResolvers({
    prewarm: false,
    resolveShellEnvironmentPolicy: () => ({ inheritAll: false, names: [] })
  })
  const firstStarted = Promise.withResolvers<void>()
  const otherStarted = Promise.withResolvers<void>()
  const first = Promise.withResolvers<void>()
  const other = Promise.withResolvers<void>()
  let duplicate = false
  const probe = createCodexModelCatalogProbe({
    resolveEnvironment: () => environment.resolveAgentEnvironment('codex'),
    resolveSavedEnvironment: () => environment.resolveAgentEnvironment('codex', true),
    resolveCommand: (options) => ({
      command: resolveCliCommand('catalog-codex', options),
      prefixArgs: []
    }),
    runSession: async (invocation, body) => {
      let id = 'replacement'
      if (invocation.command === join(bin, executable)) {
        id = duplicate ? 'duplicate' : 'original'
        duplicate = true
        firstStarted.resolve()
        await first.promise
      }
      return body({
        request: async (method) =>
          method === 'model/list'
            ? {
                data: [
                  {
                    model: id,
                    displayName: id,
                    hidden: false,
                    supportedReasoningEfforts: [],
                    isDefault: true
                  }
                ],
                nextCursor: null
              }
            : method === 'config/read'
              ? { config: {} }
              : {},
        notify: () => {}
      })
    }
  })
  const service = createAgentModelCatalogService({
    store: agentModelCatalogStore,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: folder }),
    probes: { codex: probe }
  })
  cleanups.push(environment.bindCatalogSources(['codex']), service.stop, () => {
    void rm(folder, { recursive: true, force: true })
  })
  const read = (workspacePath: string) =>
    service.read({ agent: 'codex', workspacePath, waitForListing: true })
  const firstRead = read(a)
  await firstStarted.promise
  await refreshAtRestCommandContext(() =>
    captureHostShellEnvironment(async () => {
      shell.next = { ...shell.current, PATH: `../bin${delimiter}${folder}/unused-two${delimiter}` }
    })
  )
  const shared = read(b)
  first.resolve()
  await firstRead
  expect(await shared).toMatchObject({ models: [{ id: 'original' }] })
  const unrelatedRead = agentModelCatalogStore.refresh(
    'unrelated-input-fixture',
    'codex',
    async () => {
      otherStarted.resolve()
      await other.promise
      return {
        origin: 'probe',
        models: [{ id: 'unrelated', label: 'Unrelated', efforts: [], isDefault: true }]
      }
    }
  )
  await otherStarted.promise
  await refreshAtRestCommandContext(() =>
    captureHostShellEnvironment(async () => {
      shell.next = { ...shell.current, PATH: `${replacement}${delimiter}../bin${delimiter}` }
    })
  )
  expect(await read(a)).toMatchObject({ models: [{ id: 'replacement' }] })
  other.resolve()
  expect(await unrelatedRead).toMatchObject({ models: [{ id: 'unrelated' }] })
})
