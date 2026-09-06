/// <reference types="vite/client" />

import { describe, expect, it, vi } from 'vitest'
import { z, ZodType } from 'zod'
import {
  MOBILE_WEB_BRIDGE_OPERATIONS,
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgeShellMessage,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebBridgeSubscriptionClient } from '../../../src/mobile-web/src/mobile-web-bridge-subscription-client'
import type { MobileWebBridgeSubscriptionSetup } from '../../../src/mobile-web/src/mobile-web-bridge-subscription-setup'
import { MobileWebOneShotRequestClient } from '../../../src/mobile-web/src/mobile-web-one-shot-request-client'
import { tolerantMobileWebShellPayload } from '../../../src/shared/mobile-web/shell-payload-tolerance'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const REQUEST_ID = 'R'.repeat(22)
const SUBSCRIPTION_ID = 'U'.repeat(22)
const RESPONSE_PAYLOAD_CORPUS: unknown[] = [
  null,
  true,
  false,
  0,
  1.5,
  '',
  'payload',
  [],
  {},
  { unexpected: true }
]
const contractModules = import.meta.glob(
  [
    '../../../src/shared/mobile-web/*-contract.ts',
    '!../../../src/shared/mobile-web/bridge-operation-contract.ts'
  ],
  { eager: true }
)

type NamedSchema = { name: string; schema: ZodType }

describe('mobile web shell response schema corpus', () => {
  const resultSchemas = namedSchemas('ResultSchema')
  const eventSchemas = namedSchemas('EventSchema')

  it('keeps the result and event schema corpus aligned with production grant kinds', () => {
    const registeredOperations = Object.values(MOBILE_WEB_BRIDGE_OPERATIONS).flatMap((operations) =>
      Object.keys(operations)
    )
    const oneShotGrants = MOBILE_WEB_PRODUCTION_GRANTS.filter(
      (grant) => grant.operation !== 'subscribe'
    )
    const subscriptionGrants = MOBILE_WEB_PRODUCTION_GRANTS.filter(
      (grant) => grant.operation === 'subscribe'
    )

    expect(resultSchemas.length).toBeGreaterThanOrEqual(150)
    expect(resultSchemas.length).toBeLessThanOrEqual(oneShotGrants.length)
    expect(eventSchemas).toHaveLength(subscriptionGrants.length)
    expect(MOBILE_WEB_PRODUCTION_GRANTS).toHaveLength(registeredOperations.length)
    expect(new Set(resultSchemas.map(({ name }) => name))).toHaveLength(resultSchemas.length)
    expect(new Set(eventSchemas.map(({ name }) => name))).toHaveLength(eventSchemas.length)
  })

  it('rejects invalid success payloads through every one-shot result schema', async () => {
    let caseCount = 0
    for (const { name, schema } of resultSchemas) {
      const rejected = RESPONSE_PAYLOAD_CORPUS.filter((payload) => pageRejects(schema, payload))
      expect(rejected.length, name).toBeGreaterThanOrEqual(8)
      for (const payload of rejected) {
        await expectOneShotRejection(schema, payload, name)
        caseCount += 1
      }
    }
    expect(caseCount).toBeGreaterThan(1_200)
  })

  it('retires every subscription after an invalid event payload', async () => {
    let caseCount = 0
    for (const { name, schema } of eventSchemas) {
      const rejected = RESPONSE_PAYLOAD_CORPUS.filter((payload) => pageRejects(schema, payload))
      expect(rejected.length, name).toBeGreaterThanOrEqual(8)
      for (const payload of rejected) {
        await expectSubscriptionRejection(schema, payload, name)
        caseCount += 1
      }
    }
    expect(caseCount).toBeGreaterThanOrEqual(64)
  })
})

/** What the page actually applies to a shell payload, so "cannot parse" here is the page's verdict
 * rather than the authoring schema's. */
function pageRejects(schema: ZodType, payload: unknown): boolean {
  return !tolerantMobileWebShellPayload(schema).safeParse(payload).success
}

function namedSchemas(suffix: 'ResultSchema' | 'EventSchema'): NamedSchema[] {
  const schemas: NamedSchema[] = []
  for (const [path, module] of Object.entries(contractModules)) {
    for (const [name, schema] of Object.entries(module as Record<string, unknown>)) {
      if (name.endsWith(suffix) && schema instanceof ZodType) {
        schemas.push({ name: `${path}:${name}`, schema })
      }
    }
  }
  return schemas.sort((left, right) => left.name.localeCompare(right.name))
}

async function expectOneShotRejection(
  resultSchema: ZodType,
  payload: unknown,
  label: string
): Promise<void> {
  const client = new MobileWebOneShotRequestClient({
    getGrant: () => grant('snapshot'),
    postMessage: () => true,
    envelope: () => ({ version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION, ...CONTEXT }),
    createRequestId: () => REQUEST_ID,
    otherPendingCount: () => 0
  })
  const result = client.request('workspace', 'snapshot', {}, z.object({}).strict(), resultSchema)
  const rejection = expect(result, `${label}: ${JSON.stringify(payload)}`).rejects.toMatchObject({
    code: 'invalid_message',
    retryable: false
  })

  expect(client.receive(parsedShellMessage(successResponse(payload)))).toBe(true)
  await rejection
  expect(client.pendingCount()).toBe(0)
}

async function expectSubscriptionRejection(
  eventSchema: ZodType,
  payload: unknown,
  label: string
): Promise<void> {
  const messages: MobileWebBridgePageMessage[] = []
  const onEvent = vi.fn()
  const onError = vi.fn()
  const ids = [REQUEST_ID, SUBSCRIPTION_ID]
  const client = new MobileWebBridgeSubscriptionClient({
    getGrant: () => grant('subscribe'),
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    envelope: () => ({ version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION, ...CONTEXT }),
    createMessageId: () => ids.shift() ?? 'Z'.repeat(22),
    otherPendingCount: () => 0
  })
  const subscription = exposeSubscribeWith(client)({
    capability: 'workspace',
    payload: {},
    payloadSchema: z.object({}).strict(),
    eventSchema,
    onEvent,
    onError
  })
  client.receive(parsedShellMessage(successResponse(null)))
  await subscription.ready

  expect(client.receive(parsedShellMessage(eventMessage(payload)))).toBe(true)
  expect(onEvent, label).not.toHaveBeenCalled()
  expect(onError, label).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'invalid_message', retryable: false })
  )
  expect(messages.at(-1)).toMatchObject({
    type: 'cancel',
    target: 'subscription',
    id: SUBSCRIPTION_ID
  })
}

function exposeSubscribeWith(client: MobileWebBridgeSubscriptionClient): (
  setup: MobileWebBridgeSubscriptionSetup
) => {
  ready: Promise<void>
  unsubscribe: () => void
  subscriptionId: string
} {
  return (
    client as unknown as {
      subscribeWith: ReturnType<typeof exposeSubscribeWith>
    }
  ).subscribeWith.bind(client)
}

function grant(operation: 'snapshot' | 'subscribe') {
  return {
    capability: 'workspace',
    operation,
    limits: {
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
      maxConcurrent: 2,
      rateCapacity: 4,
      rateRefillPerSecond: 1
    }
  } as const
}

function successResponse(
  payload: unknown
): Extract<MobileWebBridgeShellMessage, { type: 'response' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    ...CONTEXT,
    type: 'response',
    requestId: REQUEST_ID,
    status: 'success',
    payload
  }
}

function eventMessage(payload: unknown): Extract<MobileWebBridgeShellMessage, { type: 'event' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    ...CONTEXT,
    type: 'event',
    subscriptionId: SUBSCRIPTION_ID,
    sequence: 0,
    payload
  }
}

function parsedShellMessage(message: MobileWebBridgeShellMessage): MobileWebBridgeShellMessage {
  const parsed = parseMobileWebBridgeShellMessage(JSON.stringify(message), CONTEXT)
  if (!parsed.ok) {
    throw new Error(`Corpus produced ${parsed.error}`)
  }
  return parsed.value
}
