import type { FileWithMtime } from '../session-scanner-types'
import { throwIfAiVaultScanCancelled } from '../scan-lifecycle/ai-vault-scan-cancellation'
import {
  sessionFileIdentity,
  sessionFileVersionMatches,
  type SessionFileIdentity
} from './session-file-version'

export type SessionCopyProof = SessionFileIdentity & {
  mtimeMs: number
  sizeBytes: number | null
  sessionId: string
}
type ProofStore = {
  read(path: string): SessionCopyProof | undefined
  write(path: string, proof: SessionCopyProof): void
}
const proofs = new Map<string, SessionCopyProof>()
let store: ProofStore | null = null

export function setSessionCopyProofStore(next: ProofStore | null): void {
  store = next
  proofs.clear()
}

/** Only a successfully read metadata ID is proof; filename-derived IDs never enter this cache. */
export async function readSessionCopyProof(
  file: FileWithMtime,
  read: () => Promise<string | null>,
  signal?: AbortSignal
): Promise<string | null> {
  const saved = proofs.get(file.path) ?? store?.read(file.path)
  if (saved && sessionFileVersionMatches(saved, file)) {
    remember(file.path, saved)
    return saved.sessionId
  }
  const sessionId = await read()
  throwIfAiVaultScanCancelled(signal)
  if (sessionId) {
    const proof = {
      ...sessionFileIdentity(file),
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes ?? null,
      sessionId
    }
    remember(file.path, proof)
    store?.write(file.path, proof)
  }
  return sessionId
}

function remember(path: string, proof: SessionCopyProof): void {
  proofs.delete(path)
  proofs.set(path, proof)
  if (proofs.size > 4096) {
    const oldest = proofs.keys().next().value
    if (oldest !== undefined) {
      proofs.delete(oldest)
    }
  }
}
