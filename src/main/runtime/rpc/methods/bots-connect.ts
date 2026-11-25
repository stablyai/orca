// `bots.connect.*`: "Connect Linear" / "Connect GitHub" in one trip, run on this host as its own Orca
// account. The client opens the page this answers (for a server, in the server's own browser session,
// so the return reaches this host's loopback), then waits here for the trip's end.
import {
  ConnectorConnectCancel,
  ConnectorConnectRedeemParams,
  ConnectorConnectStart,
  ConnectorConnectWait
} from '../../../../shared/rpc-contract/bots-connector-setup-params'
import {
  cancelConnectorConnect,
  redeemConnectorFallback
} from '../../../connector-cloud/connector-connect'
import {
  startConnectorTrip,
  waitConnectorTrip
} from '../../../connector-cloud/connector-connect-trips'
import { keepConnectedLinearLogin } from '../../../linear/accounts/linear-login-store'
import { CONNECTOR_CONNECT_CODE_PATTERN } from '../../../../../cloud/packages/connector-contract/src/connect-messages'
import type { ConnectorConnectSource } from '../../../../shared/connectors/connector-cloud-contract'
import { defineMethod, InvalidArgumentError } from '../core'
import { withHostCloudClient } from './bots-slack'

// Linear's link hands the linked user's own sign-in to this host, which keeps it.
const keepLogin = (source: ConnectorConnectSource) =>
  source === 'linear' ? keepConnectedLinearLogin : undefined

export const BOT_CONNECT_METHODS = [
  defineMethod({
    name: 'bots.connect.start',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: ConnectorConnectStart,
    handler: async ({ source, switchAccount, addAccess }, context) =>
      withHostCloudClient(context, (client) =>
        startConnectorTrip(source, client, {
          switchAccount,
          keepLogin: keepLogin(source),
          ...(source === 'github' && addAccess ? { addAccess } : {})
        })
      )
  }),
  defineMethod({
    name: 'bots.connect.wait',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: ConnectorConnectWait,
    handler: async ({ tripId }, context) => waitConnectorTrip(tripId, context.signal)
  }),
  defineMethod({
    name: 'bots.connect.cancel',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: ConnectorConnectCancel,
    handler: async ({ source }) => {
      cancelConnectorConnect(source)
      return { cancelled: true }
    }
  }),
  defineMethod({
    name: 'bots.connect.redeem',
    permission: 'accounts-admin',
    share: 'not-shared',
    params: ConnectorConnectRedeemParams,
    handler: async ({ source, result }, context) => {
      if (!CONNECTOR_CONNECT_CODE_PATTERN.test(result)) {
        throw new InvalidArgumentError('That is not an Orca connect link.')
      }
      return withHostCloudClient(context, (client) =>
        redeemConnectorFallback(source, client, result, keepLogin(source))
      )
    }
  })
]
