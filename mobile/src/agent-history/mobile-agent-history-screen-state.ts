import type {
  AiVaultScanIssue,
  AiVaultSession
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

export type AgentHistoryScreenState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      sessions: AiVaultSession[]
      issues: AiVaultScanIssue[]
    }

export type FetchedHistoryState =
  | Exclude<AgentHistoryScreenState, { kind: 'ready' }>
  | (Extract<AgentHistoryScreenState, { kind: 'ready' }> & { hostId: string; client: RpcClient })
