import type * as crypto from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import { track } from '../../telemetry/client'
import { claimTabAgentSearchHint } from '../../telemetry/tab-agent-search-hint-claim'
import { restoreConsentEnv, stashAndClearConsentEnv } from '../../telemetry/client-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn(() => true) }))
vi.mock('node:crypto', async (original) => ({
  ...(await original<typeof crypto>()),
  randomInt: () => 1
}))

let env: Record<string, string | undefined>
beforeEach(() => {
  env = stashAndClearConsentEnv()
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-tab-agent-search-hint-'))
})
afterEach(async () => {
  await closeTestStores()
  restoreConsentEnv(env)
  rmSync(testState.dir, { recursive: true, force: true })
})

it('waits for permission and remembers the hint across store reloads', async () => {
  const store = createStore()
  store.updateSettings({
    telemetry: { installId: 'hint-test', existedBeforeTelemetryRelease: true, optedIn: null }
  })
  expect(claimTabAgentSearchHint(store, false)).toBeNull()
  expect(store.getSettings().telemetry?.tabAgentSearchHintCohort).toBeUndefined()
  store.updateSettings({ telemetry: { ...store.getSettings().telemetry!, optedIn: true } })
  expect(claimTabAgentSearchHint(store, false)).toBe('treatment')
  store.flushOrThrow()
  await closeTestStores()
  const reopened = createStore()
  expect(reopened.getSettings().telemetry?.tabAgentSearchHintCohort).toBe('treatment')
  expect(claimTabAgentSearchHint(reopened, false)).toBeNull()
})

it('keeps previous display state without showing again', () => {
  const store = createStore()
  expect(claimTabAgentSearchHint(store, true)).toBeNull()
  expect(store.getSettings().telemetry?.tabAgentSearchHintExposed).toBe(true)
  expect(claimTabAgentSearchHint(store, false)).toBeNull()
})

it('respects saved preferences and privacy overrides', () => {
  const store = createStore()
  store.updateSettings({
    telemetry: {
      installId: 'hint-saved',
      existedBeforeTelemetryRelease: false,
      optedIn: true,
      tabAgentSearchHintCohort: 'control'
    }
  })
  process.env.DO_NOT_TRACK = '1'
  expect(claimTabAgentSearchHint(store, false)).toBeNull()
  delete process.env.DO_NOT_TRACK
  expect(claimTabAgentSearchHint(store, false)).toBe('control')
  expect(claimTabAgentSearchHint(store, false)).toBeNull()
})

it('allows another attempt when recording fails', () => {
  const store = createStore()
  store.updateSettings({ telemetry: { ...store.getSettings().telemetry!, optedIn: true } })
  vi.mocked(track).mockReturnValueOnce(false)
  expect(claimTabAgentSearchHint(store, false)).toBeNull()
  expect(store.getSettings().telemetry?.tabAgentSearchHintExposed).toBe(false)
  expect(claimTabAgentSearchHint(store, false)).toBe('treatment')
  expect(claimTabAgentSearchHint(store, false)).toBeNull()
})

it('restores eligibility after a write failure', () => {
  const store = createStore()
  store.updateSettings({ telemetry: { ...store.getSettings().telemetry!, optedIn: true } })
  vi.spyOn(store, 'flushOrThrow').mockImplementationOnce(() => {
    throw new Error('write failed')
  })
  expect(() => claimTabAgentSearchHint(store, false)).toThrow('write failed')
  expect(store.getSettings().telemetry?.tabAgentSearchHintExposed).toBe(false)
  expect(claimTabAgentSearchHint(store, false)).toBe('treatment')
})
