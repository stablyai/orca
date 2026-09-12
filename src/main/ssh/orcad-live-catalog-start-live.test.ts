import { join } from 'node:path'
import { it, vi } from 'vitest'
import { startLiveRelayDaemon } from '../../relay/relay-live-daemon-fixture'
import { createLiveOrcadProcess } from '../orcad/orcad-live-process-fixture'
import { connectOrcadLocalRelay } from '../orcad/orcad-local-relay-connection'
import { testState } from '../persistence-test-harness'
import { verifyLiveCatalogMigration } from './orcad-live-catalog-acceptance'

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

it.skipIf(!relayEntry || !bun || !orcadEntry || process.platform === 'win32').each([
  { lostPublication: 0, restartBeforeRetry: false, unsupportedPeer: 'none' },
  { lostPublication: 1, restartBeforeRetry: false, unsupportedPeer: 'none' },
  { lostPublication: 2, restartBeforeRetry: false, unsupportedPeer: 'none' },
  { lostPublication: 2, restartBeforeRetry: true, unsupportedPeer: 'none' },
  { lostPublication: 0, restartBeforeRetry: false, unsupportedPeer: 'source' },
  { lostPublication: 0, restartBeforeRetry: false, unsupportedPeer: 'destination' }
])(
  'migrates a real folder and git cohort with reply $lostPublication lost, restartBeforeRetry=$restartBeforeRetry, unsupportedPeer=$unsupportedPeer',
  async ({ lostPublication, restartBeforeRetry, unsupportedPeer }) => {
    const daemon = await startLiveRelayDaemon(relayEntry!, bun!, [
      '--enable-ownership-transfer-mutation',
      '--enable-delegated-ownership-capture',
      ...(unsupportedPeer === 'source' ? [] : ['--enable-source-delivery-retirement'])
    ])
    const destination = createLiveOrcadProcess(orcadEntry!, join(daemon.directory, 'destination'), {
      mutationEnabled: unsupportedPeer !== 'destination'
    })
    await verifyLiveCatalogMigration({
      host: {
        directory: daemon.directory,
        sourceDirectory: daemon.directory,
        connectSource: () => connectOrcadLocalRelay({ ...daemon, initialize: () => {} }),
        destination,
        dispose: () => daemon.dispose()
      },
      lostPublication,
      restartBeforeRetry,
      unsupportedPeer
    })
  },
  420_000
)
