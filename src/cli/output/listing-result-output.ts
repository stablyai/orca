import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary,
  RuntimeWorktreeRecord
} from '../../shared/worktree/catalog/runtime-worktree-contracts'
import type { WorkspaceAnnotation } from '../workspaces/workspace-address'
import { printResult } from './command-result-output'

type ListingKey =
  | keyof RuntimeWorktreePsSummary
  | keyof RuntimeWorktreeAgentRow
  | keyof RuntimeWorktreeRecord
  | keyof WorkspaceAnnotation

// Absence of these means an older host or an unevaluated field, and agents are told to test `address` for null.
const MEANINGFUL_NULL_KEYS: ReadonlySet<string> = new Set<ListingKey>([
  'agentWait',
  'workspaceLineage',
  'crossStoreLineage',
  'address'
])

function omitListingNulls(key: string, value: unknown): unknown {
  return value === null && !MEANINGFUL_NULL_KEYS.has(key) ? undefined : value
}

export function printListingResult<TResult>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  formatter: (value: TResult) => string
): void {
  printResult(response, json, formatter, omitListingNulls)
}
