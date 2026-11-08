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
