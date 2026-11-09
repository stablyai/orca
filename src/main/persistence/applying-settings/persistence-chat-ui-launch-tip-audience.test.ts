import { Store } from '../loading-store/store'
import { prepareLegacyProfileState } from '../profile-state/legacy-json/profile-state-legacy-import'
import {
  closeTestStores,
  testState,
  dataFile,
  createStore,
  writeDataFile
} from '../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as crypto from 'node:crypto'
import { ensureChatUiLaunchTipCohort } from '../../telemetry/chat-ui-launch-tip-cohort'
import { restoreConsentEnv, stashAndClearConsentEnv } from '../../telemetry/client-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof crypto>()),
  randomInt: vi.fn(() => 0)
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-chat-ui-launch-tip-audience-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

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

it('preserves separate rollout completion through stale client writes and reloads', async () => {
  const env = stashAndClearConsentEnv()
  try {
    writeDataFile({ settings: { experimentalNativeChat: false } })
    const store = createStore()
    store.updateSettings({
      telemetry: {
        ...store.getSettings().telemetry!,
        optedIn: true,
        chatUiLaunchTipCohort: 'control'
      }
    })
    store.updateUI({ featureTipsSeenIds: ['orca-cli', 'chat-ui-here'] })
    vi.mocked(crypto.randomInt).mockImplementationOnce(() => 4)
    expect(ensureChatUiLaunchTipCohort(store)).toBe('treatment')
    expect(store.getUI().featureTipsSeenIds).toEqual(['orca-cli', 'chat-ui-here'])

    store.updateUI({ featureTipsSeenIds: ['orca-cli', 'chat-ui-here', 'voice-dictation'] })
    store.flushOrThrow()
    await closeTestStores()
    const pending = createStore()
    expect(ensureChatUiLaunchTipCohort(pending)).toBe('treatment')
    expect(pending.getUI().featureTipsSeenIds).toEqual([
      'orca-cli',
      'chat-ui-here',
      'voice-dictation'
    ])

    pending.updateUI({ featureTipsSeenIds: ['chat-ui-here-rollout-v1'] })
    pending.updateUI({ featureTipsSeenIds: ['orca-cli', 'chat-ui-here', 'cmd-j-palette'] })
    pending.flushOrThrow()
    await closeTestStores()
    const shown = createStore()
    expect(ensureChatUiLaunchTipCohort(shown)).toBe('treatment')
    expect(shown.getUI().featureTipsSeenIds).toEqual([
      'orca-cli',
      'chat-ui-here',
      'voice-dictation',
      'chat-ui-here-rollout-v1',
      'cmd-j-palette'
    ])
  } finally {
    restoreConsentEnv(env)
  }
})

async function reopen(): Promise<ReturnType<typeof createStore>> {
  await closeTestStores()
  return createStore()
}

describe('project grouping upgrade tip cohort', () => {
  const checkouts = [0, 1].map((index) => ({
    id: `checkout-${index}`,
    path: `/work/app-${index}`,
    displayName: 'App',
    badgeColor: '',
    addedAt: index,
    upstream: { owner: 'org', repo: 'app' }
  }))
  it('freezes the actual old same-host split once, and keeps dismissal across restart and stale writers', async () => {
    writeDataFile({ repos: checkouts, settings: {} })
    const store = createStore()
    const audience = store.getProjectGroupingUpgradeTipAudience()
    expect(audience).toMatchObject({ membership: 'eligible', projectCount: 1 })
    store.updateUI({ contextualToursSeenIds: ['project-grouping-upgrade'] })
    store.updateUI({ contextualToursSeenIds: [] })
    store.updateSettings({ projectGroupingMode: 'folder' })
    store.flush()
    const loaded = await reopen()
    expect(loaded.getProjectGroupingUpgradeTipAudience()).toEqual(audience)
    expect(loaded.getUI().contextualToursSeenIds).toContain('project-grouping-upgrade')
  })
  it('counts every project with split checkouts', () => {
    const other = checkouts.map((repo, index) => ({
      ...repo,
      id: `other-${index}`,
      path: `/work/api-${index}`,
      upstream: { owner: 'org', repo: 'api' }
    }))
    writeDataFile({ repos: [...checkouts, ...other], settings: {} })
    expect(createStore().getProjectGroupingUpgradeTipAudience()).toMatchObject({
      membership: 'eligible',
      projectCount: 2
    })
  })
  it.each([
    ['one checkout', checkouts.slice(0, 1), {}],
    ['physical aliases', checkouts.map((repo) => ({ ...repo, path: '/same' })), {}],
    ['different hosts', [checkouts[0], { ...checkouts[1], executionHostId: 'runtime:server' }], {}],
    ['plain folders', checkouts.map((repo) => ({ ...repo, kind: 'folder' })), {}],
    ['prior host mode', checkouts, { projectGroupingMode: 'host' }],
    [
      'prior repository override',
      checkouts,
      { projectGroupingOverrides: { 'github:org/app': 'folder' } }
    ]
  ])('excludes %s without enrolling later', async (_, repos, settings) => {
    writeDataFile({ repos, settings })
    const store = createStore()
    expect(store.getProjectGroupingUpgradeTipAudience()).toEqual({
      version: 1,
      membership: 'excluded'
    })
    store.updateSettings({ projectGroupingMode: 'repository', projectGroupingOverrides: {} })
    store.flush()
    expect((await reopen()).getProjectGroupingUpgradeTipAudience()).toEqual({
      version: 1,
      membership: 'excluded'
    })
  })
  it('excludes new profiles permanently', async () => {
    const store = createStore()
    expect(store.getProjectGroupingUpgradeTipAudience().membership).toBe('excluded')
    store.flush()
    expect((await reopen()).getProjectGroupingUpgradeTipAudience().membership).toBe('excluded')
  })
})
