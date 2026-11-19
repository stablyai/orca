import {
  closeTestStores,
  createStore,
  testState,
  writeDataFile
} from '../../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-worktree-card-style-seed-'))
})
afterEach(async () => {
  await closeTestStores()
  vi.resetAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function reopen() {
  const store = createStore()
  store.flush()
  await closeTestStores()
  return createStore()
}

function expectNewCardsWithoutNotices(store: ReturnType<typeof createStore>): void {
  expect(store.getSettings().experimentalNewWorktreeCardStyle).toBe(true)
  expect(store.getUI()).toMatchObject({
    worktreeCardsIntroNoticeSeen: true,
    worktreeCardsUpdateNoticeSeen: true
  })
}

describe('worktree card style seed', () => {
  it('starts a fresh profile on the new cards, including after restart', async () => {
    expectNewCardsWithoutNotices(await reopen())
  })

  it('starts a profile that holds only telemetry consent on the new cards', async () => {
    writeDataFile({
      settings: {
        telemetry: { optedIn: true, installId: 'inherited', existedBeforeTelemetryRelease: false }
      }
    })
    expectNewCardsWithoutNotices(await reopen())
  })

  it('keeps an existing profile without a saved choice on Classic', async () => {
    writeDataFile({ settings: { uiLanguage: 'ja' } })
    const reopened = await reopen()
    expect(reopened.getSettings().experimentalNewWorktreeCardStyle).toBe(false)
    expect(reopened.getUI().worktreeCardsIntroNoticeSeen).not.toBe(true)
  })

  it('keeps an existing profile that chose Classic on Classic', async () => {
    writeDataFile({ settings: { experimentalNewWorktreeCardStyle: false } })
    expect((await reopen()).getSettings().experimentalNewWorktreeCardStyle).toBe(false)
  })
})
