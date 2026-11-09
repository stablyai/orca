import { useState } from 'react'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type {
  MobileCommitFailureRecovery,
  RecordMobileCommitFailure
} from './mobile-commit-failure-recovery'
import { useMobileCommitFailureRecovery } from './use-mobile-commit-failure-recovery'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  worktreeLabel: string | null
}

export function useMobileSourceControlCommitFailure({
  client,
  connState,
  worktreeId,
  worktreeLabel
}: Params): {
  commitFailureRecovery: MobileCommitFailureRecovery | null
  commitFailureRecoveryAction: ReturnType<typeof useMobileCommitFailureRecovery>
  recordCommitFailure: RecordMobileCommitFailure
} {
  const [commitFailureRecovery, recordCommitFailure] = useState<MobileCommitFailureRecovery | null>(
    null
  )
  const commitFailureRecoveryAction = useMobileCommitFailureRecovery({
    client,
    connState,
    worktreeId,
    workspaceLabel: worktreeLabel,
    failure: commitFailureRecovery
  })
  return { commitFailureRecovery, commitFailureRecoveryAction, recordCommitFailure }
}
