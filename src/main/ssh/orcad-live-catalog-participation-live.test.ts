import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startLiveRelayDaemon } from '../../relay/relay-live-daemon-fixture'
import { createLiveOrcadProcess } from '../orcad/orcad-live-process-fixture'
import { connectOrcadLocalRelay } from '../orcad/orcad-local-relay-connection'
import { testState } from '../persistence-test-harness'
import { verifyLiveCatalogMigration } from './orcad-live-catalog-acceptance'
import {
  initializeProfileLifetimeAdmission,
  readCurrentProfileLifetimeParticipation
} from './profile-lifetime-admission'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import {
  readOrcadLiveProfileParticipation,
  retainOrcadLiveProfileParticipation
} from './orcad-live-profile-participation'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
const relayEntry = process.env.ORCA_TEST_RELAY_ENTRY
const bun = process.env.ORCA_TEST_BUN_RUNTIME
const orcadEntry = process.env.ORCA_TEST_ORCAD_ENTRY
const addon = process.env.ORCA_TEST_PROFILE_LOCK_ADDON

it.skipIf(!relayEntry || !bun || !orcadEntry || !addon || process.platform === 'win32')(
  'retains native originating-client participation through lost publication and destination restart',
  async () => {
    const daemon = await startLiveRelayDaemon(relayEntry!, bun!, [
      '--enable-ownership-transfer-mutation',
      '--enable-delegated-ownership-capture',
      '--enable-source-delivery-retirement'
    ])
    let inspected = false
    try {
      vi.stubEnv('ORCA_ENABLE_PROFILE_LIFETIME_ADMISSION', '1')
      vi.stubEnv('ORCA_PROFILE_LIFETIME_LOCK_ADDON', addon!)
      initializeProfileLifetimeAdmission(daemon.directory)
      const participation = readCurrentProfileLifetimeParticipation()
      expect(participation).not.toBeNull()
      const destination = createLiveOrcadProcess(orcadEntry!, join(daemon.directory, 'destination'))
      await verifyLiveCatalogMigration({
        host: {
          directory: daemon.directory,
          sourceDirectory: daemon.directory,
          connectSource: () => connectOrcadLocalRelay({ ...daemon, initialize: () => {} }),
          destination,
          dispose: async () => {
            try {
              const profile = join(daemon.directory, 'desktop')
              const intents = new OrcadLiveCutoverIntentStore(profile).list()
              expect(intents).toHaveLength(1)
              expect(intents[0].profileParticipationRequired).toBe(true)
              expect(readOrcadLiveProfileParticipation(profile, intents[0])?.participation).toEqual(
                participation
              )
              retainOrcadLiveProfileParticipation(profile, intents[0])!()
              inspected = true
            } finally {
              await daemon.dispose()
            }
          }
        },
        lostPublication: 2,
        restartBeforeRetry: true,
        unsupportedPeer: 'none'
      })
      expect(inspected).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      await daemon.dispose()
    }
  },
  420_000
)
