import { defineMethod, type RpcContext } from '../../../core'
import {
  PRDetailRecoveryCancel,
  PRDetailRecoveryCommit,
  PRDetailRecoveryStart,
  PRDetailRecoveryWait
} from '../../../../../../shared/rpc-contract/github/github-pull-request-params'
import {
  cancelPRDetailRecovery,
  commitPRDetailRecovery,
  startPRDetailRecovery,
  waitPRDetailRecovery
} from '../../../../../github/pull-requests/refresh/pr-detail-recovery-coordinator'

/** Tickets belong to the authenticated client; another caller cannot observe or cancel one by id. */
function callerKey(context: RpcContext): string {
  const client = context.clientId ?? context.connectionId
  if (!client) {
    throw new Error('caller_unidentified')
  }
  return `rpc:${client}`
}

export const GITHUB_PR_DETAIL_RECOVERY_METHODS = [
  defineMethod({
    name: 'github.prDetailRecovery.start',
    permission: 'workspace',
    params: PRDetailRecoveryStart,
    handler: async (params, context) => {
      const key = callerKey(context)
      const resolved = await context.runtime.resolvePRDetailRecoveryCandidate(params)
      return startPRDetailRecovery({ callerKey: key, pacingScope: key }, params, resolved)
    }
  }),
  defineMethod({
    name: 'github.prDetailRecovery.wait',
    permission: 'workspace',
    params: PRDetailRecoveryWait,
    handler: async (params, context) =>
      waitPRDetailRecovery(
        callerKey(context),
        params.ticketId,
        params.afterRevision,
        context.signal
      )
  }),
  defineMethod({
    name: 'github.prDetailRecovery.commit',
    permission: 'workspace',
    params: PRDetailRecoveryCommit,
    handler: async (params, context) => commitPRDetailRecovery(callerKey(context), params)
  }),
  defineMethod({
    name: 'github.prDetailRecovery.cancel',
    permission: 'workspace',
    params: PRDetailRecoveryCancel,
    handler: async (params, context) => cancelPRDetailRecovery(callerKey(context), params.ticketId)
  })
]
