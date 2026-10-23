import {
  closeTestStores,
  testState,
  createStore,
  readDataFile,
  writeDataFile
} from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../shared/constants'
import type {
  NativeChatUpgradeTipAudience,
  NativeChatUpgradeTipVariant
} from '../shared/native-chat-upgrade-tip-audience'
import { normalizeProfileProjectState } from './orca-profiles/profile-project-state-file'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-chat-upgrade-tip-audience-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

// Every build before the chat upgrade saved the whole settings document, defaults included.
const preUpgradeSettings = (
  experimentalNativeChat?: boolean,
  openAgentTabsInChatByDefault = experimentalNativeChat === true
): Record<string, unknown> => ({
  openAgentTabsInChatByDefault,
  ...(experimentalNativeChat === undefined ? {} : { experimentalNativeChat })
})

async function reopen(): Promise<ReturnType<typeof createStore>> {
  await closeTestStores()
  return createStore()
}

/** Turns Chat UI on, restarts, and reports the tip variant after each of several launches. */
async function variantAfterLaterOptIn(
  store: ReturnType<typeof createStore>
): Promise<NativeChatUpgradeTipVariant[]> {
  store.updateSettings({ experimentalNativeChat: true })
  store.flush()
  const launches: NativeChatUpgradeTipVariant[] = []
  for (let launch = 0; launch < 3; launch += 1) {
    const reopened = await reopen()
    launches.push(reopened.getNativeChatUpgradeTipVariant())
    reopened.updateSettings({ experimentalNativeChat: true })
    reopened.flush()
  }
  return launches
}

describe('native chat upgrade tip audience', () => {
  it.each([
    ['Chat UI on', preUpgradeSettings(true), 'eligible', 'chat-ui-on', 'standard'],
    [
      'Chat UI on but new tabs opening in the terminal',
      preUpgradeSettings(true, false),
      'eligible',
      'chat-ui-on-terminal-default',
      'keep-terminal'
    ],
    ['Chat UI off', preUpgradeSettings(false), 'excluded', 'chat-ui-off', 'none'],
    ['Chat UI never set', preUpgradeSettings(), 'excluded', 'chat-ui-unset', 'none'],
    [
      'Chat UI on but saved by a build that already had the chat upgrade',
      { experimentalNativeChat: true },
      'excluded',
      'chat-ui-on-unproven',
      'none'
    ]
  ])(
    'decides an existing profile with %s from what it saved',
    (_, settings, membership, basis, variant) => {
      writeDataFile({ settings })
      const store = createStore()
      expect(store.getNativeChatUpgradeTipVariant()).toBe(variant)
      store.flush()
      expect(readDataFile()).toHaveProperty('nativeChatUpgradeTipAudience', {
        version: 1,
        membership,
        basis
      })
    }
  )

  it('keeps a brand new profile out of the audience', () => {
    const store = createStore()
    expect(store.getNativeChatUpgradeTipVariant()).toBe('none')
    store.flush()
    expect(readDataFile()).toHaveProperty('nativeChatUpgradeTipAudience.basis', 'new-profile')
  })

  it.each([
    ['saved Chat UI off', () => writeDataFile({ settings: preUpgradeSettings(false) })],
    ['no saved Chat UI choice', () => writeDataFile({ settings: preUpgradeSettings() })],
    ['a brand new profile', () => {}]
  ])(
    'never lets a profile with %s join by turning Chat UI on later, across restarts',
    async (_, seed) => {
      seed()
      const store = createStore()
      expect(store.getNativeChatUpgradeTipVariant()).toBe('none')
      expect(await variantAfterLaterOptIn(store)).toEqual(['none', 'none', 'none'])
    }
  )

  it('turns Chat UI off for a profile whose new tabs opened in the terminal, once', async () => {
    writeDataFile({ settings: preUpgradeSettings(true, false) })
    const store = createStore()
    expect(store.getSettings().experimentalNativeChat).toBe(false)
    store.flush()
    expect(readDataFile()).toHaveProperty('settings.experimentalNativeChat', false)
    // Turning it back on later sticks: the saved Default view is gone after the first save.
    store.updateSettings({ experimentalNativeChat: true })
    store.flush()
    expect((await reopen()).getSettings().experimentalNativeChat).toBe(true)
  })

  it('keeps Chat UI on for a profile whose new tabs opened in chat', () => {
    writeDataFile({ settings: preUpgradeSettings(true) })
    expect(createStore().getSettings().experimentalNativeChat).toBe(true)
  })

  it('keeps a chat-view member on the standard tip after turning Chat UI off', async () => {
    writeDataFile({ settings: preUpgradeSettings(true) })
    const store = createStore()
    store.updateSettings({ experimentalNativeChat: false })
    store.flush()
    expect((await reopen()).getNativeChatUpgradeTipVariant()).toBe('standard')
  })

  it('keeps a terminal-view member on the chat mode switch tip after turning Chat UI on', async () => {
    writeDataFile({ settings: preUpgradeSettings(true, false) })
    const store = createStore()
    expect(await variantAfterLaterOptIn(store)).toEqual([
      'keep-terminal',
      'keep-terminal',
      'keep-terminal'
    ])
  })

  it('keeps an excluded record when a later build turns Chat UI on by default', async () => {
    // A future build where Chat UI is a regular setting that defaults on.
    writeDataFile({
      settings: { experimentalNativeChat: true },
      nativeChatUpgradeTipAudience: { version: 1, membership: 'excluded', basis: 'chat-ui-off' }
    })
    for (let launch = 0; launch < 3; launch += 1) {
      const store = launch === 0 ? createStore() : await reopen()
      expect(store.getNativeChatUpgradeTipVariant()).toBe('none')
      store.flush()
    }
    expect(readDataFile()).toHaveProperty('nativeChatUpgradeTipAudience.basis', 'chat-ui-off')
  })

  it('fails closed when a later build finds Chat UI on but no record and no pre-upgrade save', () => {
    // A record lost by some later rewrite must not be recaptured from the live switch.
    writeDataFile({ settings: { experimentalNativeChat: true } })
    const store = createStore()
    expect(store.getNativeChatUpgradeTipVariant()).toBe('none')
    store.flush()
    expect(readDataFile()).toHaveProperty(
      'nativeChatUpgradeTipAudience.basis',
      'chat-ui-on-unproven'
    )
  })

  it('removes the pre-upgrade marker on the first save, so no later load can prove membership again', () => {
    writeDataFile({ settings: preUpgradeSettings(false) })
    const store = createStore()
    store.flush()
    expect(readDataFile()).not.toHaveProperty('settings.openAgentTabsInChatByDefault')
  })

  it('never seeds a record or the pre-upgrade marker from defaults', () => {
    const defaults = getDefaultPersistedState('/home/test')
    expect(defaults).not.toHaveProperty('nativeChatUpgradeTipAudience')
    expect(defaults.settings).not.toHaveProperty('openAgentTabsInChatByDefault')
  })

  it.each([
    ['an unknown version', { version: 2, membership: 'eligible', basis: 'chat-ui-on' }],
    ['an unknown membership', { version: 1, membership: 'yes', basis: 'chat-ui-on' }],
    ['a non-object', 'eligible'],
    ['null', null]
  ])('fails closed on a saved record with %s', (_, record) => {
    writeDataFile({ settings: preUpgradeSettings(true), nativeChatUpgradeTipAudience: record })
    const store = createStore()
    expect(store.getNativeChatUpgradeTipVariant()).toBe('none')
    store.flush()
    expect(readDataFile()).toHaveProperty('nativeChatUpgradeTipAudience.basis', 'unreadable-record')
  })

  it('keeps a saved record even when the current settings disagree', () => {
    writeDataFile({
      settings: preUpgradeSettings(false),
      nativeChatUpgradeTipAudience: { version: 1, membership: 'eligible', basis: 'chat-ui-on' }
    })
    expect(createStore().getNativeChatUpgradeTipVariant()).toBe('standard')
  })

  it('profile transfers carry a saved record and never invent one', () => {
    const excluded: NativeChatUpgradeTipAudience = {
      version: 1,
      membership: 'excluded',
      basis: 'chat-ui-off'
    }
    const settings = {
      ...getDefaultPersistedState('/home/test').settings,
      experimentalNativeChat: true
    }
    expect(
      normalizeProfileProjectState({ settings, nativeChatUpgradeTipAudience: excluded })
    ).toHaveProperty('nativeChatUpgradeTipAudience', excluded)
    expect(normalizeProfileProjectState({ settings })).not.toHaveProperty(
      'nativeChatUpgradeTipAudience'
    )
  })

  it('keeps the tip dismissed when a stale client writes an older seen list', async () => {
    writeDataFile({ settings: preUpgradeSettings(true) })
    const store = createStore()
    store.updateUI({ featureTipsSeenIds: ['native-chat-upgrade'] })
    // A paired client hydrated before the tip was shown marks another tip seen.
    store.updateUI({ featureTipsSeenIds: ['voice-dictation'] })
    store.flush()
    expect((await reopen()).getUI().featureTipsSeenIds).toEqual([
      'native-chat-upgrade',
      'voice-dictation'
    ])
  })
})
