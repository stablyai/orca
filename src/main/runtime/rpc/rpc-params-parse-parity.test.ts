import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'
import { RPC_PARAMS_BY_METHOD } from '../../../shared/rpc-contract/rpc-params-catalog.generated'
import { parseRpcRequestParams } from './dispatcher-request-parsing'
import type { RpcAnyMethod, RpcRequest } from './core'

// Why: mobile pins its own zod (~4.4.3) while the host is on ~4.5.4. A params schema
// that parses differently across the two is a wire-format difference, not a detail.
const MOBILE_ZOD = fileURLToPath(
  new URL('../../../../mobile/node_modules/zod/index.js', import.meta.url)
)

const TRACED_METHODS = [
  'github.project.addIssueCommentBySlug',
  'nativeChat.readSession',
  'repo.hooks'
] as const

// Why: recorded, explained differences only. An empty list is the passing state.
const ACCEPTED_DELTAS: { method: string; probe: string; reason: string }[] = []

type Outcome =
  | { kind: 'accepted'; data: unknown }
  | { kind: 'rejected'; message: string }
  | { kind: 'threw'; message: string }

// Why: a params schema that throws instead of returning an issue is itself a
// behaviour both sides must share, so the harness records it rather than crashing.
function guard(run: () => Outcome): Outcome {
  try {
    return run()
  } catch (error) {
    return { kind: 'threw', message: error instanceof Error ? error.message : String(error) }
  }
}

const META = { runtimeId: 'parity' }

function hostOutcome(schema: ZodType, input: unknown): Outcome {
  return guard(() => {
    const method = { name: 'parity', params: schema, handler: () => undefined } as RpcAnyMethod
    const request = { id: '1', authToken: 't', method: 'parity', params: input } as RpcRequest
    const result = parseRpcRequestParams(request, method, META)
    return result.error
      ? {
          kind: 'rejected',
          message: String((result.error as { error: { message: string } }).error.message)
        }
      : { kind: 'accepted', data: result.value }
  })
}

function clientOutcome(schema: ZodType, input: unknown): Outcome {
  return guard(() => {
    const result = schema.safeParse(input ?? {})
    return result.success
      ? { kind: 'accepted', data: result.data }
      : { kind: 'rejected', message: result.error.issues[0]?.message ?? 'invalid_argument' }
  })
}

function objectKeys(schema: unknown): string[] {
  const shape = (schema as { def?: { shape?: Record<string, unknown> } }).def?.shape
  return shape ? Object.keys(shape) : []
}

// omitted / absent / undefined / null / wrong type / transformed / defaulted / unknown key
const AMBIENT_PROBES: [string, unknown][] = [
  ['omitted', undefined],
  ['empty-object', {}],
  ['null', null],
  ['number', 42],
  ['string', 'value'],
  ['array', []],
  ['unknown-key', { __orcaUnknownKey: 'x' }]
]

const FIELD_VALUES: [string, unknown][] = [
  ['absent', Symbol.for('absent')],
  ['undefined', undefined],
  ['null', null],
  ['number', 7],
  ['string', 'value'],
  ['empty-string', ''],
  ['boolean', true],
  ['object', {}],
  ['array', []]
]

function probesFor(schema: ZodType): [string, unknown][] {
  const probes = [...AMBIENT_PROBES]
  for (const key of objectKeys(schema)) {
    for (const [label, value] of FIELD_VALUES) {
      if (label === 'absent') {
        continue
      }
      probes.push([`${key}:${label}`, { [key]: value }])
    }
    probes.push([`${key}:absent-with-sibling`, { __orcaUnknownKey: 'x' }])
  }
  return probes
}

describe('RPC params parse parity', () => {
  it('parses identically on the host and on the mobile-resolved zod', async () => {
    vi.doMock('zod', async () => await import(MOBILE_ZOD))
    vi.resetModules()
    const clientCatalog = (
      await import('../../../shared/rpc-contract/rpc-params-catalog.generated')
    ).RPC_PARAMS_BY_METHOD as Record<string, ZodType | null>
    vi.doUnmock('zod')
    vi.resetModules()

    // Why: without two distinct module graphs this gate would compare a schema with
    // itself and could never fail.
    expect(clientCatalog['repo.hooks']).not.toBe(RPC_PARAMS_BY_METHOD['repo.hooks'])
    for (const traced of TRACED_METHODS) {
      expect(Object.keys(RPC_PARAMS_BY_METHOD)).toContain(traced)
      expect(probesFor(RPC_PARAMS_BY_METHOD[traced] as ZodType).length).toBeGreaterThan(
        AMBIENT_PROBES.length
      )
    }

    const accepted = new Set(ACCEPTED_DELTAS.map((delta) => `${delta.method}|${delta.probe}`))
    const differences: string[] = []

    for (const [method, schema] of Object.entries(RPC_PARAMS_BY_METHOD)) {
      const clientSchema = clientCatalog[method]
      if (schema === null) {
        if (clientSchema !== null) {
          differences.push(`${method}|shape: host has no params, client does`)
        }
        continue
      }
      if (!clientSchema) {
        differences.push(`${method}|shape: missing from the client catalog`)
        continue
      }
      for (const [probe, input] of probesFor(schema as ZodType)) {
        if (accepted.has(`${method}|${probe}`)) {
          continue
        }
        const host = hostOutcome(schema as ZodType, input)
        const client = clientOutcome(clientSchema, input)
        if (host.kind !== client.kind) {
          differences.push(`${method}|${probe}: host ${host.kind}, client ${client.kind}`)
          continue
        }
        if (host.kind === 'accepted' && client.kind === 'accepted') {
          try {
            expect(client.data).toEqual(host.data)
          } catch {
            differences.push(
              `${method}|${probe}: parsed values differ (${JSON.stringify(host.data)} vs ${JSON.stringify(client.data)})`
            )
          }
          continue
        }
        if (
          host.kind !== 'accepted' &&
          client.kind !== 'accepted' &&
          host.message !== client.message
        ) {
          differences.push(
            `${method}|${probe}: ${host.kind} differs (${host.message} vs ${client.message})`
          )
        }
      }
    }

    expect(differences.slice(0, 25)).toEqual([])
  })
})
