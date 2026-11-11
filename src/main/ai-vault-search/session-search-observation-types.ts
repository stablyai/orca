import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import type { FileWithMtime } from '../ai-vault/session-scanner-types'
export type SessionSearchObservedFacts = {
  file: Omit<FileWithMtime, 'modifiedAt'>
  dependency?: string
  revision?: number
}
export type SessionSearchObservationDebt = {
  failures: number
  attempted: number
  force: boolean
  metadata?: boolean
  issue?: AiVaultScanIssue
}
export type SessionSearchObservationInput = {
  path: string
  force: boolean
  readOwed?: boolean
  metadataOwed?: boolean
  dirtyRevision?: number
}
export type SessionSearchPreparedObservation = SessionSearchObservationInput & {
  accepted?: SessionSearchObservedFacts
  token: string
  authority: number
  refusalRevision?: number
  attempt: boolean
}
export type SessionSearchObservationOutcome = SessionSearchPreparedObservation & {
  observed?: SessionSearchObservedFacts
  metadataOnly?: boolean
  missing?: boolean
  issue?: AiVaultScanIssue
}
export type SessionSearchInventoryCommand =
  | {
      kind: 'observe-prepare'
      scope: string
      generation: number
      inputs: SessionSearchObservationInput[]
    }
  | {
      kind: 'observe-apply'
      scope: string
      generation: number
      outcomes: SessionSearchObservationOutcome[]
    }
  | { kind: 'forget-files'; scope: string; paths: string[]; notify?: boolean; cutoff?: number }
  | { kind: 'observe-ack'; scope: string; receipts: { path: string; revision: number }[] }
export type SessionSearchInventoryResult = {
  refusals?: { path: string; revision: number }[]
  prepared?: SessionSearchPreparedObservation[]
  observations?: {
    path: string
    file?: FileWithMtime
    changed: boolean
    force: boolean
    readable: boolean
    metadata?: boolean
  }[]
  filesDelta?: number
  failuresDelta?: number
  runnableDelta?: number
  missingParents?: string[]
  removedFiles?: string[]
}
