import { parentPort, workerData } from 'node:worker_threads'
import {
  runCodexHookPassRequest,
  toTransportedError
} from '../../hooks/installation/codex-hook-pass-worker'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import {
  grantCodexProjectTrust,
  listCodexProjectTrustOwnedConfigs,
  removeOrcaCreatedProjectTrust
} from './codex-project-trust-transaction'
import type {
  CodexProjectTrustWorkerRequest,
  CodexProjectTrustWorkerResponse
} from './codex-project-trust-worker-protocol'

export function handleCodexProjectTrustRequest(
  request: CodexProjectTrustWorkerRequest
): CodexProjectTrustWorkerResponse | Promise<CodexProjectTrustWorkerResponse> {
  try {
    switch (request.kind) {
      case 'hookPass':
        return runCodexHookPassRequest(request).then(
          (hookPass) => ({ id: request.id, ok: true, hookPass }),
          (error: unknown) => ({ id: request.id, ok: false, error: toTransportedError(error) })
        )
      case 'grant':
        grantCodexProjectTrust(request.configFiles, request.workspacePath, request.ledgerPath)
        return { id: request.id, ok: true }
      case 'listOwnedConfigs':
        return {
          id: request.id,
          ok: true,
          configFiles: listCodexProjectTrustOwnedConfigs(request.projectPath, request.ledgerPath)
        }
      case 'removeOwned':
        removeOrcaCreatedProjectTrust(request.configPath, request.projectPath, request.ledgerPath)
        return { id: request.id, ok: true }
    }
  } catch (error) {
    return { id: request.id, ok: false, error: toTransportedError(error) }
  }
}

// Imported without a parent port only by its test fixture.
const port = parentPort
if (port) {
  installWorkerSendLedger('orca-codex-project-trust')
  adoptMainResourcesPath()
  port.on('message', async (request: CodexProjectTrustWorkerRequest) => {
    port.postMessage(await handleCodexProjectTrustRequest(request))
  })
}

/** Windows hook commands name a bundled binary under resources; it must match main's spelling. */
function adoptMainResourcesPath(): void {
  const data: unknown = workerData
  const resourcesPath =
    data && typeof data === 'object' && 'resourcesPath' in data ? data.resourcesPath : undefined
  if (typeof resourcesPath === 'string' && !('resourcesPath' in process)) {
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath })
  }
}
