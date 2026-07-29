import { useState } from 'react'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type {
  MobileCommitFailureRecovery,
  RecordMobileCommitFailure
} from './mobile-commit-failure-recovery'
import { useMobileCommitFailureRecovery } from './use-mobile-commit-failure-recovery'

type Params = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
}

export function useMobileSourceControlCommitFailure({ client, connState, worktreeId }: Params): {
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
    failure: commitFailureRecovery
  })
  return { commitFailureRecovery, commitFailureRecoveryAction, recordCommitFailure }
}
