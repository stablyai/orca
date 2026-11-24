// A teammate's phone on Orca Cloud's shares routes, with its share credential (it has no Orca sign-in):
// a message held for a host that is away, and the states of those it held.
import {
  ConnectorShareHeldSchema,
  ConnectorShareHoldSchema,
  sharePath,
  type ConnectorShareHeld,
  type ConnectorShareHoldRequest
} from '../../../../src/shared/connector-share-contract'
import type { z } from 'zod'

const REQUEST_TIMEOUT_MS = 15_000

export type PhoneSharedAgentCloudAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; status: number | null }

async function call<T>(
  origin: string,
  credential: string,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown
): Promise<PhoneSharedAgentCloudAnswer<T>> {
  // Hermes has no AbortSignal.timeout.
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(new URL(path, origin).toString(), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: abort.signal
    })
    if (!response.ok) {
      return { ok: false, status: response.status }
    }
    const value = schema.safeParse(await response.json())
    return value.success ? { ok: true, value: value.data } : { ok: false, status: null }
  } catch {
    return { ok: false, status: null }
  } finally {
    clearTimeout(timer)
  }
}

export function phoneSharedAgentCloud(agent: {
  connectorOrigin: string
  credential: string
  shareId: string
}) {
  const path = sharePath(agent.shareId, 'messages')
  return {
    hold: (request: ConnectorShareHoldRequest) =>
      call(agent.connectorOrigin, agent.credential, path, ConnectorShareHoldSchema, request),
    held: (): Promise<PhoneSharedAgentCloudAnswer<ConnectorShareHeld>> =>
      call(agent.connectorOrigin, agent.credential, path, ConnectorShareHeldSchema)
  }
}
