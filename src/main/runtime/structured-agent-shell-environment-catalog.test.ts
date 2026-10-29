import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentModelCatalogSettingsExpiry } from '../native-chat/agent-model-catalog/agent-model-catalog-account-expiry'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprintForRecord } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  captureHostShellEnvironment,
  createStructuredAgentEnvironmentResolvers,
  structuredAgentEnvironmentIdentity
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
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async (options?: { startedAfter?: number }) => {
    if (options?.startedAfter !== undefined) {
      shell.current = { ...shell.next }
    }
    return { ...shell.current }
  }
}))
vi.mock('../pty/windows-environment-path', () => ({
  cachedPersistedWindowsPathSegments: () => shell.saved,
  readPersistedWindowsPathSegmentsAsync: async () => (shell.saved = [...shell.nextSaved]),
  mergePersistedWindowsPathAsync: async () => {}
}))

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop())
  vi.restoreAllMocks()
  shell.current = { PATH: '/a', IGNORED: 'a' }
  shell.next = { ...shell.current }
  shell.saved = []
  shell.nextSaved = []
})

function rig() {
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
    resolveShellEnvironmentPolicy: () => ({ inheritAll: false, names: [] })
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

it('preserves ignored inputs and other agent overlays, and releases only the exact registration', async () => {
  const h = rig()
  const source = h.service.captureSource(h.record)
  cleanups.push(() => source.release?.())
  let overlay = '/one'
  const other = createStructuredAgentEnvironmentResolvers({
    resolveShellEnvironmentPolicy: () => ({ inheritAll: true, names: [] }),
    resolveAgentLaunchEnv: () => ({ PATH: overlay })
  })
  const leaveOld = other.bindCatalogSources(['pi'])
  const leaveNew = other.bindCatalogSources(['pi'])
  leaveOld()
  cleanups.push(leaveNew)
  const piRevision = agentModelCatalogStore.retirementRevision('pi')
  await captureHostShellEnvironment(async () => {
    overlay = '/two'
    shell.next = { PATH: '/a', IGNORED: 'b' }
  })
  expect(source()).toBe(true)
  expect(agentModelCatalogStore.retirementRevision('pi')).toBe(piRevision + 1)
  leaveNew()
  await captureHostShellEnvironment(async () => {
    overlay = '/three'
  })
  expect(agentModelCatalogStore.retirementRevision('pi')).toBe(piRevision + 1)
  const injected = createStructuredAgentEnvironmentResolvers({
    resolveEnvironment: async () => ({ PATH: '/fixed' })
  })
  cleanups.push(injected.bindCatalogSources(['grok']))
  expect(await injected.resolveAgentEnvironment('grok')).toEqual({ PATH: '/fixed' })
})

it('keeps more than 256 live producer leases and releases a replaced source independently', () => {
  const service = createAgentModelCatalogService({
    store: agentModelCatalogStore,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'HOME', path: '/account' }),
    listsInChatFolder: new Set(['opencode'])
  })
  cleanups.push(service.stop)
  const record = agentSessionRecordFixture()
  const origin = { provider: 'opencode', location: record.location }
  const first = service.captureSource(origin)
  const replacement = service.captureSource(origin)
  const others = Array.from({ length: 257 }, (_, index) =>
    service.captureSource({
      ...origin,
      location: { ...origin.location, workspaceId: `other-workspace-${index}` }
    })
  )
  expect(first()).toBe(true)
  first.release?.()
  expect(first()).toBe(false)
  expect(replacement()).toBe(true)
  service.retireContext(record.location.workspaceId)
  expect(replacement()).toBe(false)
  expect(others.every((source) => source())).toBe(true)
  replacement.release?.()
  others.forEach((source) => source.release?.())
})

it('compares Windows effective key spelling and ignores a shadow Path value', () => {
  expect(
    structuredAgentEnvironmentIdentity({ Path: 'a', PATH: 'shadow', token: 'x' }, 'win32')
  ).toBe(structuredAgentEnvironmentIdentity({ PATH: 'a', TOKEN: 'x' }, 'win32'))
  expect(structuredAgentEnvironmentIdentity({ PATH: 'b', TOKEN: 'x' }, 'win32')).not.toBe(
    structuredAgentEnvironmentIdentity({ PATH: 'a', TOKEN: 'x' }, 'win32')
  )
})

it('freezes persisted Windows PATH before the detection callback refreshes its cache', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  cleanups.push(() => Object.defineProperty(process, 'platform', platform))
  shell.current = { PATH: 'C:\\shell', IGNORED: 'a' }
  shell.next = { ...shell.current }
  shell.saved = ['C:\\before']
  shell.nextSaved = [...shell.saved]
  const h = rig()
  const source = h.service.captureSource(h.record)
  cleanups.push(() => source.release?.())
  await captureHostShellEnvironment(async () => {
    shell.saved = ['C:\\after']
    shell.nextSaved = [...shell.saved]
  })
  expect(source()).toBe(false)
})

it('catalog-scale settles retired publication chains and bounds Refresh registrations by live owners', async () => {
  for (const owners of [5, 50]) {
    const records = new Map(
      Array.from({ length: owners }, (_, index) => {
        const record = {
          ...agentSessionRecordFixture(),
          sessionId: `scale-${owners}-${index}`,
          provider: 'grok',
          accountHome: { variable: 'GROK_HOME', path: `/generated-account/${owners}` },
          providerHandleChain: [],
          location: {
            executionHostId: 'local' as const,
            wslDistro: null,
            workspaceId: `scale-workspace-${owners}-${index}`,
            workspaceKind: 'folder' as const
          }
        }
        return [record.sessionId, record] as const
      })
    )
    const folder = Promise.withResolvers<void>()
    let held = true
    let pendingFolders = 0
    let peakFolders = 0
    let folderCalls = 0
    let envReads = 0
    let overlay = 'before'
    let saves = 0
    let serializedBytes = 0
    let serializedModels = 0
    let firstSnapshotModels = 0
    let pendingSnapshot:
      | (() => readonly NonNullable<ReturnType<typeof agentModelCatalogStore.get>>[])
      | undefined
    await agentModelCatalogStore.attachPersistence({
      load: async () => [],
      save: (snapshot) => {
        saves++
        pendingSnapshot = snapshot
      },
      flush: async () => {
        const entries = pendingSnapshot?.()
        pendingSnapshot = undefined
        if (!entries) {
          return
        }
        serializedBytes += Buffer.byteLength(JSON.stringify(entries))
        const snapshotModels = entries.reduce((count, entry) => count + entry.models.length, 0)
        firstSnapshotModels = snapshotModels
        serializedModels += snapshotModels
      }
    })
    const service = createAgentModelCatalogService({
      store: agentModelCatalogStore,
      getConversation: (id) => {
        const held = records.get(id)
        return held ? agentSessionConversationView(held) : undefined
      },
      getRecord: (id) => records.get(id),
      drivesRecord: () => true,
      resolveAccountHome: async () => ({
        variable: 'GROK_HOME',
        path: `/generated-account/${owners}`
      }),
      listsInChatFolder: new Set(['grok']),
      recordWorkspacePath: async (record) => {
        folderCalls++
        peakFolders = Math.max(peakFolders, ++pendingFolders)
        try {
          if (held) {
            await folder.promise
          }
          return `/generated-workspace/${record.sessionId}`
        } finally {
          pendingFolders--
        }
      },
      workspaceMayOverrideDefaultModel: async () => false
    })
    const sources = [...records.values()].map((record) => service.captureSource(record))
    const registrations = [...records.values()].map(() =>
      createStructuredAgentEnvironmentResolvers({
        prewarm: false,
        processEnvironment: {},
        resolveShellEnvironmentPolicy: () => ({ inheritAll: true, names: [] }),
        resolveAgentLaunchEnv: () => {
          envReads++
          return { CATALOG_SOURCE: overlay }
        }
      }).bindCatalogSources(['grok'])
    )
    const models = Array.from({ length: 20 }, (_, index) => ({
      id: `model-${index}`,
      label: `Model ${index}`,
      isDefault: index === 0,
      efforts: [{ value: 'high', label: 'High' }]
    }))
    const rows = [...records.values()]
    const success = vi.spyOn(agentModelCatalogStore, 'recordSuccess')
    const start = performance.now()
    try {
      rows.forEach((record, index) => {
        service.recordLiveListing(record.sessionId, { models }, sources[index])
        service.recordLiveListing(record.sessionId, { models }, sources[index])
      })
      await vi.waitFor(() => expect(pendingFolders).toBe(owners))
      const refreshStart = agentModelCatalogStore.retirementRevision('grok')
      await captureHostShellEnvironment(async () => {
        overlay = 'after'
      })
      expect(envReads).toBe(owners * 2)
      expect(sources.every((source) => !source())).toBe(true)
      sources.forEach((source) => source.release?.())
      registrations.forEach((release) => release())
      held = false
      folder.resolve()
      await vi.waitFor(() => expect(folderCalls).toBe(owners * 2))
      await Promise.resolve()
      expect(success).not.toHaveBeenCalled()
      expect(pendingFolders).toBe(0)
      const revisionAfterRefresh = agentModelCatalogStore.retirementRevision('grok')
      const expireSettings = createAgentModelCatalogSettingsExpiry(agentModelCatalogStore, {})
      expireSettings(
        { agentDefaultArgs: { grok: '--fixture-setting' } },
        { agentDefaultArgs: { grok: '--fixture-setting' } }
      )
      const revisionAfterSettings = agentModelCatalogStore.retirementRevision('grok')
      expect(revisionAfterSettings - revisionAfterRefresh).toBe(1)
      await captureHostShellEnvironment(async () => {
        overlay = 'released'
      })
      expect(envReads).toBe(owners * 2)
      expect(agentModelCatalogStore.retirementRevision('grok')).toBe(revisionAfterSettings)
      const nextSources = rows.map((record) => service.captureSource(record))
      rows.forEach((record, index) => {
        service.recordLiveListing(record.sessionId, { models }, nextSources[index])
        service.recordLiveListing(record.sessionId, { models }, nextSources[index])
      })
      await vi.waitFor(() => expect(success).toHaveBeenCalledTimes(owners * 2))
      await vi.waitFor(() => expect(pendingFolders).toBe(0))
      expect(saves).toBe(owners)
      expect(serializedModels).toBe(0)
      await agentModelCatalogStore.flushPersistence()
      expect(serializedModels).toBeGreaterThanOrEqual(owners * models.length)
      expect(serializedModels).toBe(firstSnapshotModels)
      nextSources.forEach((source) => source.release?.())
      expect(nextSources.every((source) => !source())).toBe(true)
      process.stdout.write(
        `CATALOG_PUBLICATION ${JSON.stringify({
          owners,
          modelRows: models.length,
          retiredEvents: owners * 2,
          successorEvents: owners * 2,
          envReads,
          refreshRetirements: revisionAfterRefresh - refreshStart,
          settingsRetirements: revisionAfterSettings - revisionAfterRefresh,
          folderCalls,
          peakFolders,
          pendingFolders,
          publicationCalls: success.mock.calls.length,
          saves,
          serializedModels,
          firstSnapshotModels,
          serializedBytes,
          elapsedMs: performance.now() - start
        })}\n`
      )
    } finally {
      held = false
      folder.resolve()
      sources.forEach((source) => source.release?.())
      registrations.forEach((release) => release())
      service.stop()
      success.mockRestore()
    }
  }
})
