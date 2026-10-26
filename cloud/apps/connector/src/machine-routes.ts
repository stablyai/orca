import type { CloudDatabase } from '@orca-cloud/cloud-database'
import {
  CONNECTOR_CONTRACT_VERSION,
  CONNECTOR_PATHS,
  ConnectorAcksRequestSchema,
  ConnectorEventsRequestSchema,
  ConnectorHelloRequestSchema,
  ConnectorPollRequestSchema,
  type ConnectorDelivery,
  type ConnectorHelloResponse,
  type ConnectorPollResponse
} from '@orca-cloud/connector-contract'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { lockConnectorHost, type ConnectorHosts } from './connector-hosts.js'
import type { ConnectorInbox, Unsettled } from './connector-inbox.js'
import { storedEvents, type ConnectorThreads } from './connector-threads.js'
import type { InboxWaker } from './inbox-waker.js'
import type { MachineEnv } from './machine-auth.js'
import type { SlackEdge } from './slack-edge.js'

class TokenExpiredDuringPoll extends Error {}

// The machine API behind a connector token: hello, the held poll, confirmations and turn events.
export function registerMachineRoutes(
  app: Hono<MachineEnv>,
  deps: {
    database: CloudDatabase
    inbox: ConnectorInbox
    threads: ConnectorThreads
    hosts: ConnectorHosts
    waker: InboxWaker
    now: () => number
    holdMs: number
    limitBody: MiddlewareHandler
    slack?: Pick<SlackEdge, 'onEvents' | 'onAcks'>
  }
): void {
  const { database, inbox, threads, hosts, waker, now, holdMs, limitBody, slack } = deps

  // Acks and events apply only under the current hello. Any other is refused with hello_required, so a
  // 204 always means applied: the machine keeps what was refused and sends it again after a new hello.
  async function onCurrentHello(
    context: Context<MachineEnv>,
    helloRev: number,
    run: (transaction: CloudDatabase, hostId: string) => Promise<void>
  ): Promise<Response> {
    const { hostId } = context.get('host')
    const current = await database.transaction(async (transaction) => {
      await lockConnectorHost(transaction, hostId)
      if (!(await hosts.isCurrentHello(transaction, hostId, helloRev))) {
        return false
      }
      await run(transaction, hostId)
      return true
    })
    return current ? context.body(null, 204) : context.json({ error: 'hello_required' }, 409)
  }

  app.put(CONNECTOR_PATHS.hello, limitBody, async (context) => {
    const body = ConnectorHelloRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    if (body.data.contract < CONNECTOR_CONTRACT_VERSION) {
      return context.json({ error: 'client_too_old' }, 426)
    }
    const host = context.get('host')
    const helloRev = await database.transaction(async (transaction) => {
      await lockConnectorHost(transaction, host.hostId)
      return await hosts.recordHello(transaction, host, body.data)
    })
    return context.json({ helloRev } satisfies ConnectorHelloResponse, 200)
  })

  app.post(CONNECTOR_PATHS.poll, limitBody, async (context) => {
    const body = ConnectorPollRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const { hostId, expiresAt } = context.get('host')
    const { helloRev } = body.data
    await hosts.touch(hostId)
    const holdUntil = Math.min(Date.now() + holdMs, expiresAt)
    let deliveries: ConnectorDelivery[] = []
    let unsettled: Unsettled[] = []
    for (;;) {
      const waiter = waker.register(hostId)
      try {
        // Each pass decides under the host lock, so a newer hello either lands before it (and this
        // refuses) or after it has committed what it hands out.
        const pass = await database
          .transaction(async (transaction) => {
            await lockConnectorHost(transaction, hostId)
            if (!(await hosts.isCurrentHello(transaction, hostId, helloRev))) {
              return null
            }
            const recovered = (await hosts.takeUnsettledDue(transaction, hostId))
              ? await inbox.listUnsettled(transaction, hostId)
              : []
            const claimed = await inbox.claim(transaction, hostId)
            // Last moment before commit: a token past its expiry rolls the pass back, so nothing
            // goes out on it and the next token's poll sees the same inbox.
            if (Date.now() >= expiresAt) {
              throw new TokenExpiredDuringPoll()
            }
            return { recovered, ...claimed }
          })
          .catch((error: unknown) => {
            if (error instanceof TokenExpiredDuringPoll) {
              return { recovered: [], deliveries: [], nextLeaseDueAt: null }
            }
            throw error
          })
        if (pass === null) {
          return context.json({ error: 'hello_required' }, 409)
        }
        deliveries = pass.deliveries
        unsettled = pass.recovered
        const remaining = holdUntil - Date.now()
        const ready = deliveries.length > 0 || unsettled.length > 0
        if (ready || remaining <= 0 || waker.draining) {
          break
        }
        // A lease running out sends no notification, so wake for the next one too.
        const leaseDueMs =
          pass.nextLeaseDueAt === null ? remaining : Math.max(0, pass.nextLeaseDueAt - now())
        await waiter.wait(Math.min(remaining, leaseDueMs))
      } finally {
        waiter.cancel()
      }
    }
    const response: ConnectorPollResponse = {
      v: 1,
      serverNow: now(),
      holdMs,
      ...(unsettled.length > 0 ? { unsettled } : {}),
      deliveries,
      ...(waker.draining ? { control: { reconnect: true as const } } : {})
    }
    return context.json(response)
  })

  app.post(CONNECTOR_PATHS.acks, limitBody, async (context) => {
    const body = ConnectorAcksRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    return await onCurrentHello(context, body.data.helloRev, async (transaction, hostId) => {
      await inbox.acknowledge(transaction, hostId, body.data.acks)
      await slack?.onAcks(
        transaction,
        hostId,
        body.data.acks.map((ack) => ack.deliveryId)
      )
    })
  })

  app.post(CONNECTOR_PATHS.events, limitBody, async (context) => {
    const body = ConnectorEventsRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    return await onCurrentHello(context, body.data.helloRev, async (transaction, hostId) => {
      if (await hosts.advanceEventsSeq(transaction, hostId, body.data.seq)) {
        const events = storedEvents(body.data.events)
        await threads.applyEvents(transaction, hostId, events)
        await slack?.onEvents(transaction, hostId, events)
      }
    })
  })
}
