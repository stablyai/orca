import { parentPort } from 'node:worker_threads'
import { installWorkerSendLedger } from '../../../worker-threads/worker-send-ledger'
import {
  grantCodexProjectTrust,
  listCodexProjectTrustOwnedConfigs,
  removeOrcaCreatedProjectTrust
} from './codex-project-trust-transaction'
import type {
  CodexProjectTrustWorkerFailure,
  CodexProjectTrustWorkerRequest,
  CodexProjectTrustWorkerResponse
} from './codex-project-trust-worker-protocol'

function toFailure(error: unknown): CodexProjectTrustWorkerFailure {
  const value = error instanceof Error ? error : new Error(String(error))
  const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined
  return { name: value.name, message: value.message, ...(code ? { code } : {}) }
}

export function handleCodexProjectTrustRequest(
  request: CodexProjectTrustWorkerRequest
): CodexProjectTrustWorkerResponse {
  try {
    switch (request.kind) {
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
    return { id: request.id, ok: false, error: toFailure(error) }
  }
}

// Imported without a parent port only by its test fixture.
const port = parentPort
if (port) {
  installWorkerSendLedger('orca-codex-project-trust')
  port.on('message', (request: CodexProjectTrustWorkerRequest) => {
    port.postMessage(handleCodexProjectTrustRequest(request))
  })
}
