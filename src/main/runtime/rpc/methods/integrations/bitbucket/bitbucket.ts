import { defineMethod } from '../../../core'
import { BitbucketConnectParam } from '../../../../../../shared/rpc-contract/bitbucket/bitbucket-params'

export const BITBUCKET_METHODS = [
  defineMethod({
    name: 'bitbucket.connect',
    permission: 'accounts-admin',
    params: BitbucketConnectParam,
    handler: async (params, { runtime }) =>
      runtime.bitbucketConnect({
        authMode: params.authMode,
        accessToken: params.accessToken ?? null,
        email: params.email ?? null,
        apiToken: params.apiToken ?? null,
        baseUrl: params.baseUrl ?? null
      })
  }),
  defineMethod({
    name: 'bitbucket.disconnect',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, { runtime }) => runtime.bitbucketDisconnect()
  }),
  defineMethod({
    name: 'bitbucket.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.bitbucketStatus()
  })
]
