import { randomUUID } from 'node:crypto'
import { ConnectorDeliverySchema } from '@orca-cloud/connector-contract'
import type { Env, Hono, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import type { queueDelivery } from './queue-delivery.js'

const DevEnqueueSchema = z.object({
  hostId: z.string().min(1),
  externalId: z.string().min(1),
  placeId: z.string().min(1).default('dev-place'),
  deliveryId: z.string().min(1).optional(),
  // The kind-specific delivery fields; the envelope is filled in below and checked by the contract.
  delivery: z.record(z.string(), z.unknown())
})

// Queues a delivery without Slack for a host that said hello; only on a loopback origin.
export function registerDevEnqueueRoute<E extends Env>(
  app: Hono<E>,
  deps: {
    queue: (input: Parameters<typeof queueDelivery>[1]) => ReturnType<typeof queueDelivery>
    limitBody: MiddlewareHandler
  }
): void {
  app.post('/dev/enqueue', deps.limitBody, async (context) => {
    const body = DevEnqueueSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const { hostId, externalId, placeId } = body.data
    const deliveryId = body.data.deliveryId ?? randomUUID()
    const delivery = ConnectorDeliverySchema.safeParse({
      ...body.data.delivery,
      deliveryId,
      seq: 1,
      expiresAt: 1,
      conversation: { source: 'slack', externalId }
    })
    if (!delivery.success) {
      return context.json({ error: 'invalid_request' }, 400)
    }
    const {
      deliveryId: _id,
      seq: _seq,
      expiresAt: _expiresAt,
      conversation: _c,
      ...rest
    } = delivery.data
    const status = await deps.queue({
      thread: {
        conversation: { source: 'slack', externalId },
        place: { workspaceId: 'dev', containerId: 'dev', threadId: externalId },
        ownerUserId: 'dev',
        hostId,
        placeId
      },
      deliveryId,
      body: rest
    })
    if (status === 'unknown_host') {
      return context.json({ error: status }, 404)
    }
    if (status === 'not_this_hosts_thread') {
      return context.json({ error: status }, 409)
    }
    return context.json({ deliveryId, status })
  })
}
