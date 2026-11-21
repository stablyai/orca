// The Composio RPCs the chat's setup cards call, all on the phone's bot allowlist.
import * as z from 'zod'
import {
  bindDeferredRpcOperation,
  defineRpcOperation
} from '../../../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../../../transport/rpc/rpc-operation-result-reader'

export const composioStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.status',
    method: 'bots.composio.status',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'composio-status',
      // `key` is ok, none, rejected or unreadable; a newer state reads as not ok.
      z.looseObject({ key: z.string(), added: z.boolean() })
    )
  })
)

export const composioConnectionsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.connections',
    method: 'bots.composio.connections',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'composio-connections',
      z.looseObject({
        connections: z.array(
          z.looseObject({
            app: z.string(),
            // Composio's name for the app; absent from an older host.
            name: z.string().optional(),
            status: z.string(),
            label: z.string().nullable(),
            // The sign-in's account, which Disconnect names; absent from an older host.
            id: z.string().optional()
          })
        ),
        pending: z.array(z.looseObject({ app: z.string(), url: z.string() }))
      })
    )
  })
)

/** A page of Composio's app catalog, read with the host's key. */
export const composioAppsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.apps',
    method: 'bots.composio.apps',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant(
      'composio-apps',
      z.looseObject({
        apps: z.array(z.looseObject({ slug: z.string(), name: z.string() })),
        nextCursor: z.string().nullable()
      })
    )
  })
)

/** How one app signs in at Composio now. */
export const composioAppRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.app',
    method: 'bots.composio.app',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-app', z.looseObject({ signIn: z.string() }))
  })
)

/** Checks the key with Composio and saves it on the host; bots never see it. */
export const composioSetKey = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.setKey',
    method: 'bots.composio.setKey',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-key-set', z.unknown())
  })
)

export const composioDeclineKey = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.declineKey',
    method: 'bots.composio.declineKey',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-key-declined', z.unknown())
  })
)

/** Starts the app's sign-in; the host waits for it and the phone opens the page. */
export const composioConnect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.connect',
    method: 'bots.composio.connect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-connect', z.looseObject({ url: z.string() }))
  })
)

/** Gives the bot its Composio tool, for an app with nothing to sign in to. */
export const composioAdd = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.add',
    method: 'bots.composio.add',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-added', z.unknown())
  })
)

export const composioDisconnect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.disconnect',
    method: 'bots.composio.disconnect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-disconnected', z.unknown())
  })
)

export const composioCancelConnect = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.cancelConnect',
    method: 'bots.composio.cancelConnect',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-connect-cancelled', z.unknown())
  })
)

const EventsStatusSchema = z.looseObject({
  target: z.enum(['none', 'ours', 'other']),
  on: z.boolean(),
  ingress: z.looseObject({ hookId: z.string(), signed: z.boolean() }).optional()
})
export type MobileComposioEventsStatus = z.infer<typeof EventsStatusSchema>

export const composioEventsStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.eventsStatus',
    method: 'bots.composio.eventsStatus',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-events-status', EventsStatusSchema)
  })
)

export const composioSetUpEvents = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.setUpEvents',
    method: 'bots.composio.setUpEvents',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-events-set-up', z.unknown())
  })
)

/** Makes the project's events hook, which the by-hand steps copy. */
export const composioEventsByHand = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'bots.composio.eventsByHand',
    method: 'bots.composio.eventsByHand',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('composio-events-by-hand', z.unknown())
  })
)
