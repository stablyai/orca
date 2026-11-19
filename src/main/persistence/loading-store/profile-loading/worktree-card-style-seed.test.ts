import {
  closeTestStores,
  createSqliteTestStore,
  createStore,
  testState,
  writeDataFile
} from '../../persistence-test-harness'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { initializeNewOrcaProfileState } from '../../../orca-profiles/storage/new-profile-state'
import { getOrcaProfileDataFile } from '../../../orca-profiles/profile-storage-paths'
import { Store } from '../store'
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
  it.each([
    [
      'inherited consent',
      { optedIn: true, installId: 'inherited', existedBeforeTelemetryRelease: true }
    ],
    ['no consent', undefined]
  ] as const)('starts a created profile with %s on the new cards', async (_, telemetry) => {
    installFakeAppEnvironment({ getPath: () => testState.dir })
    initializeNewOrcaProfileState('persistence-test', telemetry, testState.dir)
    const dataFile = getOrcaProfileDataFile('persistence-test', testState.dir)
    createSqliteTestStore(Store, { dataFile }).flush()
    await closeTestStores()
    expectNewCardsWithoutNotices(createSqliteTestStore(Store, { dataFile }))
  })

  it('starts a profile that holds only telemetry consent on the new cards', async () => {
    writeDataFile({
      settings: {
        telemetry: { optedIn: true, installId: 'inherited', existedBeforeTelemetryRelease: false }
      }
    })
    expectNewCardsWithoutNotices(await reopen())
  })
})
