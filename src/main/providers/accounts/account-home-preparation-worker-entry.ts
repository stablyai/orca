import { parentPort, workerData } from 'node:worker_threads'
import { importClaudeHome } from '../../claude-accounts/sign-in/claude-home-import'
import { syncSystemCodexResourcesIntoManagedHome } from '../../codex/configuration/homes/codex-home-paths'
import { syncSystemConfigIntoManagedCodexHome } from '../../codex/configuration/settings/codex-config-mirror'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'
import type { AccountHomePreparationJob } from './account-home-preparation-worker'

installWorkerSendLedger('orca-account-home-preparation')
if (!parentPort) {
  throw new Error('Account home preparation must run on a worker thread')
}
const port = parentPort
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: prepareAccountHomeInWorker is the only spawner and passes this job union.
const job = workerData as AccountHomePreparationJob

async function prepare(): Promise<void> {
  if (job.kind === 'claude-import') {
    await importClaudeHome(job.sourceHome, job.destination, job.defaultHome, job.importHistory)
  } else {
    syncSystemCodexResourcesIntoManagedHome(job.homePath, job.systemHomePath)
    syncSystemConfigIntoManagedCodexHome({
      runtimeHomePath: job.homePath,
      systemHomePath: job.systemHomePath
    })
  }
}

void prepare()
  .then(
    () => port.postMessage({ ok: true }),
    (error: unknown) =>
      port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  )
  .finally(() => port.close())
