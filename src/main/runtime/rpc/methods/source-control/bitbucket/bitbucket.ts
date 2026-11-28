import { defineMethod } from '../../../core'
import { BitbucketConnectParams } from '../../../../../../shared/rpc-contract/source-control/bitbucket-params'
import {
  connectBitbucket,
  disconnectBitbucket,
  getBitbucketConnectionStatus
} from '../../../../../bitbucket/credential-connection'
import { _resetPreflightCache } from '../../../../../preflight/agent-detection'

// Why on the host: its preflight and Bitbucket client read ~/.orca/bitbucket-credential.* there.
export const BITBUCKET_METHODS = [
  defineMethod({
    name: 'bitbucket.connect',
    permission: 'accounts-admin',
    params: BitbucketConnectParams,
    handler: async (params) => {
      const result = await connectBitbucket(params)
      if (result.ok) {
        // Refresh cached source-control preflight so the card shows connected without a restart.
        _resetPreflightCache()
      }
      return result
    }
  }),
  defineMethod({
    name: 'bitbucket.disconnect',
    permission: 'accounts-admin',
    params: null,
    handler: async () => {
      await disconnectBitbucket()
      _resetPreflightCache()
      return { ok: true as const }
    }
  }),
  defineMethod({
    name: 'bitbucket.status',
    permission: 'workspace',
    params: null,
    // Metadata only: status never decrypts the secret or returns it.
    handler: async () => getBitbucketConnectionStatus()
  })
]
