// The Codex project trust worker's real handler behind an asynchronous message boundary.
import { inProcessWorker } from '../../../worker-threads/in-process-worker.test-fixture'
import { handleCodexProjectTrustRequest } from './codex-project-trust-worker-entry'

export const codexProjectTrustTestWorker = inProcessWorker(handleCodexProjectTrustRequest)
