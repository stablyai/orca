import { vi } from 'vitest'
import type * as LegacyImportWorkerModule from './journal-legacy-import-worker'

vi.mock('./journal-legacy-import-worker', async (importOriginal) => {
  const actual = await importOriginal<typeof LegacyImportWorkerModule>()
  const { createLegacyImportTestWorker } =
    await import('./journal-legacy-import-worker-test-fixture')
  return {
    ...actual,
    runLegacyTranscriptImportWorker: (
      ...args: Parameters<typeof actual.runLegacyTranscriptImportWorker>
    ) =>
      actual.runLegacyTranscriptImportWorker(
        args[0],
        args[1],
        args[2],
        createLegacyImportTestWorker
      )
  }
})
