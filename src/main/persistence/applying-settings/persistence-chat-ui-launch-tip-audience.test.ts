import type { PersistedState } from '../../../shared/persisted-state-types'
import { Store } from '../loading-store/store'
import { prepareLegacyProfileState } from '../profile-state/legacy-json/profile-state-legacy-import'
import { LoadedCohortMigrationOperations } from '../loading-store/loaded-cohort-migrations'
import { getDefaultPersistedState } from '../../../shared/constants'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { buildNativeChatProviderUpdate } from '../../../shared/native-chat/native-chat-providers'
import { nativeChatPreferenceFor } from '../../../shared/structured-native-chat-launch-route'
import { isStructuredNativeChatDefaultFor } from '../../runtime/rpc/methods/structured-agent-session-policy'
import {
  closeTestStores,
  testState,
  createStore,
  readDataFile,
  readPersistedState,
  writeDataFile,
  writePersistedStateJson,
  dataFile
} from '../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-chat-ui-launch-tip-audience-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function reopen(): Promise<ReturnType<typeof createStore>> {
  await closeTestStores()
  return createStore()
}

describe('Chat UI launch tip audience', () => {
  it.each([
    ['saved before the Chat UI switch existed', {}, 'eligible', 'chat-ui-off'],
    ['Chat UI off', { experimentalNativeChat: false }, 'eligible', 'chat-ui-off'],
    ['Chat UI on', { experimentalNativeChat: true }, 'eligible', 'chat-ui-on'],
    [
      'Chat UI on with new tabs opening in the terminal',
      { experimentalNativeChat: true, openAgentTabsInChatByDefault: false },
      'eligible',
      'chat-ui-off'
    ]
  ])('records an existing profile %s once', async (_, settings, membership, basis) => {
    writeDataFile({ settings })
    const store = createStore()
    store.flush()
    expect(store.getChatUiLaunchTipVariant()).toBe(basis)
    const record = { version: 1, membership, basis }
    expect(readDataFile()).toHaveProperty('chatUiLaunchTipAudience', record)
    expect(Object.hasOwn(readPersistedState().settings, 'experimentalNativeChat')).toBe(
      Object.hasOwn(settings, 'experimentalNativeChat')
    )
    if ('experimentalNativeChat' in settings) {
      expect(readPersistedState().settings).toHaveProperty(
        'experimentalNativeChat',
        settings.experimentalNativeChat
      )
    }
    expect(store.getSettings()).not.toHaveProperty('experimentalNativeChat')

    // The audience, rather than retained old data, owns completion on desktop.
    const reopened = await reopen()
    reopened.flush()
    expect(reopened.getChatUiLaunchTipVariant()).toBe(basis)
    expect(readDataFile()).toHaveProperty('chatUiLaunchTipAudience', record)
  })

  it('keeps a brand new profile out of the audience', () => {
    createStore().flush()
    expect(readDataFile()).toHaveProperty('chatUiLaunchTipAudience', {
      version: 1,
      membership: 'excluded',
      basis: 'new-profile'
    })
  })

  it.each([
    ['malformed', { membership: 'eligible' }],
    ['from a future version', { version: 2, membership: 'eligible', basis: 'chat-ui-off' }]
  ])('fails closed on a %s record instead of rederiving it', (_, chatUiLaunchTipAudience) => {
    writeDataFile({ settings: { experimentalNativeChat: false }, chatUiLaunchTipAudience })
    createStore().flush()
    expect(readDataFile()).toHaveProperty('chatUiLaunchTipAudience', {
      version: 1,
      membership: 'excluded',
      basis: 'unreadable-record'
    })
  })

  it('drops the retired upgrade tip audience record', () => {
    writeDataFile({
      settings: {},
      nativeChatUpgradeTipAudience: { version: 1, membership: 'eligible', basis: 'chat-ui-on' }
    })
    createStore().flush()
    expect(readDataFile()).not.toHaveProperty('nativeChatUpgradeTipAudience')
  })
})

describe('carrying what launches opened while Chat UI was experimental', () => {
  it.each([
    [
      'saved before the Chat UI switch existed',
      {},
      { agentDefaultSurface: 'terminal', nativeChatProviders: {} }
    ],
    [
      'Chat UI off',
      { experimentalNativeChat: false },
      { agentDefaultSurface: 'terminal', nativeChatProviders: {} }
    ],
    [
      'Chat UI on',
      { experimentalNativeChat: true },
      { agentDefaultSurface: 'chat', nativeChatProviders: {} }
    ],
    [
      'Chat UI off, turning chat choices the switch masked to CLI',
      { experimentalNativeChat: false, nativeChatProviders: { claude: true, codex: false } },
      { agentDefaultSurface: 'terminal', nativeChatProviders: {} }
    ],
    [
      'Chat UI on with new tabs opening in the terminal',
      {
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: false,
        nativeChatProviders: { codex: true }
      },
      { agentDefaultSurface: 'terminal', nativeChatProviders: {} }
    ],
    [
      'Chat UI on, keeping an explicit CLI choice',
      { experimentalNativeChat: true, nativeChatProviders: { claude: false, 'acme-agent': true } },
      { agentDefaultSurface: 'chat', nativeChatProviders: { claude: false } }
    ]
  ])('saves the choices of a profile %s, once', async (_, settings, carried) => {
    writeDataFile({ settings })
    const store = createStore()
    expect(store.getSettings()).toMatchObject(carried)
    store.flush()

    // A later choice survives the next load.
    store.updateSettings({ nativeChatProviders: { gemini: true } })
    store.flush()
    expect((await reopen()).getSettings().nativeChatProviders).toEqual({ gemini: true })
  })

  it('writes no choices for a brand new profile', () => {
    expect(createStore().getSettings().nativeChatProviders).toBeUndefined()
  })

  it('writes no choices when the audience record already exists, even malformed', () => {
    const nativeChatProviders = { claude: true }
    writeDataFile({
      settings: { experimentalNativeChat: false, nativeChatProviders },
      chatUiLaunchTipAudience: { membership: 'eligible' }
    })
    const settings = createStore().getSettings()
    expect(settings.nativeChatProviders).toEqual(nativeChatProviders)
    expect(settings.agentDefaultSurface).toBe('terminal')
  })
})

it('retains valid saved agent IDs after migration, an unrelated provider edit, main save and reopen', async () => {
  writeDataFile({
    settings: {
      experimentalNativeChat: true,
      nativeChatProviders: {
        'acme-agent': false,
        'other-agent': true,
        malformed: 'true',
        'invalid id': true
      }
    }
  })
  const store = createStore()
  expect(nativeChatPreferenceFor(store.getSettings(), 'acme-agent')).toBe(false)
  expect(nativeChatPreferenceFor(store.getSettings(), 'new-agent')).toBe(true)
  store.updateSettings({
    nativeChatProviders: { ...store.getSettings().nativeChatProviders, 'saved-agent': true }
  })
  store.updateSettings(buildNativeChatProviderUpdate(store.getSettings(), 'claude', false))
  const overrides = store.getSettings().nativeChatProviders
  store.updateSettings({ agentDefaultSurface: 'terminal' })
  expect(store.getSettings().nativeChatProviders).toEqual(overrides)
  store.flush()
  const saved = (await reopen()).getSettings()
  expect(saved.nativeChatProviders).toMatchObject({
    'acme-agent': false,
    'saved-agent': true,
    claude: false
  })
  expect(saved.nativeChatProviders).not.toHaveProperty('malformed')
  expect(saved.nativeChatProviders).not.toHaveProperty('invalid id')
  for (const [agent, on] of [
    ['acme-agent', false],
    ['saved-agent', true],
    ['absent-agent', false],
    ['malformed', false]
  ] as const) {
    expect(nativeChatPreferenceFor(saved, agent)).toBe(on)
    // Same runtime settings read that the legacy create-support admission uses; capabilities remain separate.
    expect(
      isStructuredNativeChatDefaultFor(
        { requireStore: () => ({ getSettings: () => saved }) },
        agent
      )
    ).toBe(on)
  }
})

it.each([100, 1000])(
  'carries %i saved choices linearly, commits once, and terminates on reopen',
  async (size) => {
    let reads = 0
    const choices: Record<string, boolean> = {}
    for (let index = 0; index < size; index++) {
      Object.defineProperty(choices, `agent-${index}`, {
        enumerable: true,
        get: () => {
          reads++
          return index % 2 === 0
        }
      })
    }
    const state = getDefaultPersistedState(testState.dir)
    const saved = { settings: { experimentalNativeChat: true, nativeChatProviders: choices } }
    const runtime = { loadNeedsSave: false }
    const operations = new LoadedCohortMigrationOperations(runtime)
    const audience = operations.captureChatUiLaunchTipAudience(saved)
    const carried = operations.carryChatUiChoices(state, saved, audience)
    expect(reads).toBe(size)
    expect(Object.keys(carried.settings.nativeChatProviders ?? {})).toHaveLength(size / 2)
    expect(carried.workspaceSession).toBe(state.workspaceSession)
    expect(runtime.loadNeedsSave).toBe(true)
    const completed = { ...carried, chatUiLaunchTipAudience: audience }
    runtime.loadNeedsSave = false
    expect(operations.captureChatUiLaunchTipAudience(completed)).toEqual(audience)
    expect(operations.carryChatUiChoices(completed, completed, audience)).toBe(completed)
    expect(reads).toBe(size)
    expect(runtime.loadNeedsSave).toBe(false)

    // Seed SQLite before counting: importing legacy JSON is a separate existing write.
    writePersistedStateJson(dataFile(), JSON.stringify({ settings: saved.settings }))
    const commits = vi.spyOn(
      ProfileStateSqliteAuthority.prototype,
      'writeCompleteSerializedDomains'
    )
    const selective = vi.spyOn(ProfileStateSqliteAuthority.prototype, 'writeSerializedDomains')
    try {
      const store = createStore()
      store.flush()
      expect(commits.mock.calls.length + selective.mock.calls.length).toBe(1)
      const reopened = await reopen()
      reopened.flush()
      // Other normalizers may save on reopen; this migration's own zero-debt re-entry is asserted above.
      expect(readDataFile()).toHaveProperty('chatUiLaunchTipAudience', audience)
      expect(reopened.getSettings().nativeChatProviders).not.toHaveProperty('agent-0')
      expect(reopened.getSettings().agentDefaultSurface).toBe('chat')
      expect(nativeChatPreferenceFor(reopened.getSettings(), 'future-agent')).toBe(true)
      expect(reopened.getSettings().nativeChatProviders?.['agent-1']).toBe(false)
    } finally {
      commits.mockRestore()
      selective.mockRestore()
    }
  }
)

it('normalizes invalid defaults on load and main updates without changing overrides', async () => {
  writeDataFile({
    settings: { agentDefaultSurface: 'invalid', nativeChatProviders: { 'saved-agent': true } },
    chatUiLaunchTipAudience: { version: 2, membership: 'eligible', basis: 'chat-ui-on' }
  })
  const store = createStore()
  expect(store.getSettings().agentDefaultSurface).toBe('terminal')
  const updates: Parameters<typeof store.updateSettings>[0] = {}
  Reflect.set(updates, 'agentDefaultSurface', null)
  store.updateSettings(updates)
  store.flush()
  const settings = (await reopen()).getSettings()
  expect(settings.agentDefaultSurface).toBe('terminal')
  expect(settings.nativeChatProviders).toEqual({ 'saved-agent': true })
})

it.each([
  {},
  { experimentalNativeChat: true },
  { experimentalNativeChat: false },
  { experimentalNativeChat: null },
  { experimentalNativeChat: { future: ['raw', 1] } }
])(
  'retains only original raw data through Store saves, live updates and reopen: %o',
  async (original) => {
    writeDataFile({ settings: original })
    const store = createStore()
    const listener = vi.fn()
    store.onSettingsChanged(listener)
    const check = (saved: PersistedState['settings']) => {
      expect(Object.hasOwn(saved, 'experimentalNativeChat')).toBe(
        Object.hasOwn(original, 'experimentalNativeChat')
      )
      if ('experimentalNativeChat' in original) {
        expect(saved).toHaveProperty('experimentalNativeChat', original.experimentalNativeChat)
      }
    }
    store.flush()
    check(readPersistedState().settings)
    const updates = {
      agentDefaultSurface: 'terminal' as const,
      nativeChatProviders: { 'registered-agent': true },
      experimentalNativeChat: 'ignored-input'
    }
    expect(store.updateSettings(updates, { notifyListeners: true })).not.toHaveProperty(
      'experimentalNativeChat'
    )
    store.flush()
    check(readPersistedState().settings)
    const exported = JSON.parse(store.prepareProfileStateExport().json)
    check(exported.settings)
    for (const [delta, live] of listener.mock.calls) {
      expect(delta).not.toHaveProperty('experimentalNativeChat')
      expect(live).not.toHaveProperty('experimentalNativeChat')
    }
    expect(listener).toHaveBeenCalledOnce()
    const reopened = await reopen()
    expect(reopened.getSettings()).toMatchObject({
      agentDefaultSurface: 'terminal',
      nativeChatProviders: { 'registered-agent': true }
    })
    expect(reopened.getSettings()).not.toHaveProperty('experimentalNativeChat')
    check(JSON.parse(reopened.prepareProfileStateExport().json).settings)
  }
)

it('keeps frozen imported originals separate for each Store and prepared export', () => {
  const first = prepareLegacyProfileState(
    dataFile(),
    JSON.stringify({ settings: { experimentalNativeChat: { original: false } } })
  )
  const second = new Store({
    dataFile: dataFile(),
    serializedState: JSON.stringify({ settings: {} })
  })
  const third = new Store({
    dataFile: dataFile(),
    serializedState: JSON.stringify({ settings: { experimentalNativeChat: null } })
  })
  const input = { theme: 'dark' as const, experimentalNativeChat: true }
  second.updateSettings(input)
  expect(second.getSettings()).not.toHaveProperty('experimentalNativeChat')
  expect(JSON.parse(second.prepareProfileStateExport().json).settings).not.toHaveProperty(
    'experimentalNativeChat'
  )
  expect(JSON.parse(third.prepareProfileStateExport().json).settings).toHaveProperty(
    'experimentalNativeChat',
    null
  )
  expect(JSON.parse(first.prepared.json).settings).toHaveProperty('experimentalNativeChat', {
    original: false
  })
})
