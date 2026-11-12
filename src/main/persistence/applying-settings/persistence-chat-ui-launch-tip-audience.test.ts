import { Store } from '../loading-store/store'
import { prepareLegacyProfileState } from '../profile-state/legacy-json/profile-state-legacy-import'
import {
  closeTestStores,
  createStore,
  testState,
  dataFile,
  writeDataFile
} from '../persistence-test-harness'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as crypto from 'node:crypto'
import {
  ensureChatUiLaunchTipCohort,
  isChatUiLaunchTipDeferredForConsent
} from '../../telemetry/chat-ui-launch-tip-cohort'
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

const EXISTING_TELEMETRY = {
  optedIn: true,
  installId: 'install',
  existedBeforeTelemetryRelease: true
} as const

it('keeps a re-offered card completed through stale client writes and reloads', async () => {
  const env = stashAndClearConsentEnv()
  try {
    writeDataFile({
      settings: {
        experimentalNativeChat: false,
        telemetry: { ...EXISTING_TELEMETRY, chatUiLaunchTipCohort: 'control' }
      }
    })
    const store = createStore()
    vi.mocked(crypto.randomInt).mockClear()
    expect(ensureChatUiLaunchTipCohort(store)).toBe('control')
    store.updateUI({ featureTipsSeenIds: ['orca-cli', 'chat-ui-here', 'chat-ui-here-v2'] })
    store.updateUI({ featureTipsSeenIds: ['orca-cli', 'chat-ui-here', 'cmd-j-palette'] })
    store.flushOrThrow()
    await closeTestStores()

    const reloaded = createStore()
    expect(ensureChatUiLaunchTipCohort(reloaded)).toBe('control')
    expect(crypto.randomInt).not.toHaveBeenCalled()
    expect(reloaded.getSettings().telemetry).not.toHaveProperty('chatUiLaunchTipRolloutCohort')
    expect(reloaded.getUI().featureTipsSeenIds).toEqual([
      'orca-cli',
      'chat-ui-here',
      'chat-ui-here-v2',
      'cmd-j-palette'
    ])
  } finally {
    restoreConsentEnv(env)
  }
})

it('never writes a launch-tip assignment for a profile without one', async () => {
  const env = stashAndClearConsentEnv()
  try {
    writeDataFile({ settings: { experimentalNativeChat: false, telemetry: EXISTING_TELEMETRY } })
    const store = createStore()
    vi.mocked(crypto.randomInt).mockClear()
    expect(ensureChatUiLaunchTipCohort(store)).toBeUndefined()
    expect(crypto.randomInt).not.toHaveBeenCalled()
    store.flushOrThrow()
    await closeTestStores()
    const telemetry = createStore().getSettings().telemetry
    expect(telemetry).not.toHaveProperty('chatUiLaunchTipCohort')
    expect(telemetry).not.toHaveProperty('chatUiLaunchTipRolloutCohort')
    expect(telemetry).not.toHaveProperty('chatUiLaunchTipTargeting')
  } finally {
    restoreConsentEnv(env)
  }
})

it('holds a re-offer back while the telemetry banner is unresolved', () => {
  const env = stashAndClearConsentEnv()
  try {
    writeDataFile({
      ui: { featureTipsSeenIds: ['chat-ui-here', 'chat-ui-here-rollout-v1'] },
      settings: {
        experimentalNativeChat: false,
        telemetry: { ...EXISTING_TELEMETRY, optedIn: null, chatUiLaunchTipRolloutCohort: 'control' }
      }
    })
    expect(ensureChatUiLaunchTipCohort(createStore())).toBe('control')
    expect(isChatUiLaunchTipDeferredForConsent()).toBe(true)
  } finally {
    restoreConsentEnv(env)
  }
})
