// Local only: the machine key belongs to this host, so no paired client may sign it in or out.
import {
  CloudBeginSignInParams,
  CloudFinishSignInParams
} from '../../../../shared/rpc-contract/cloud-params'
import type { ConnectorCloud } from '../../../connector-cloud/connector-cloud'
import { defineMethod, type RpcContext } from '../core'

function localConnectorCloud({
  runtime,
  clientKind
}: Pick<RpcContext, 'runtime' | 'clientKind'>): ConnectorCloud {
  if (clientKind !== undefined) {
    throw new Error('Run `orca cloud` on the Orca host itself.')
  }
  const cloud = runtime.getConnectorCloud()
  if (!cloud) {
    throw new Error('connectors_disabled')
  }
  return cloud
}

export const CLOUD_METHODS = [
  defineMethod({
    name: 'cloud.status',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, context) => localConnectorCloud(context).status()
  }),
  defineMethod({
    name: 'cloud.beginSignIn',
    permission: 'accounts-admin',
    params: CloudBeginSignInParams,
    handler: async ({ name }, context) => localConnectorCloud(context).beginSignIn(name)
  }),
  defineMethod({
    name: 'cloud.finishSignIn',
    permission: 'accounts-admin',
    params: CloudFinishSignInParams,
    handler: async ({ flowId }, context) =>
      localConnectorCloud(context).finishSignIn(flowId, context.signal)
  }),
  defineMethod({
    name: 'cloud.signOut',
    permission: 'accounts-admin',
    params: null,
    handler: async (_, context) => localConnectorCloud(context).signOut()
  })
]
