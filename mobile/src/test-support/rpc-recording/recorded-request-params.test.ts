import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RPC_METHODS_WITHOUT_SHARED_PARAMS,
  RPC_PARAMS_BY_METHOD
} from '../../../../src/shared/rpc-contract/rpc-params-catalog.generated'
import { defineMethod } from '../../../../src/main/runtime/rpc/core'
import { parseRpcRequestParams } from '../../../../src/main/runtime/rpc/dispatcher-request-parsing'
import { derivedGoldens } from './derived-goldens'
import { readGolden } from './golden-recording'
import { readScenarios } from './scenario-input'

/**
 * Every request a golden records putting on the wire, parsed by the host's own dispatcher against
 * the host's own params schema. The goldens script the host's replies, so a request the real host
 * would refuse with `invalid_argument` is recorded as a success unless something checks it here;
 * and a desktop change that tightens a schema is invisible to every golden without this.
 */

const root = resolve(import.meta.dirname, '../../../..')
const manifest = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
).scenarios
const directory =
  process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

/**
 * Keys the host's schema strips that the phone sends on purpose, each with its reason. Only an
 * older or newer host reading the key justifies an entry; an entry nothing strips fails, so the list
 * only shrinks.
 */
const STRIPPED_KEY_INVENTORY: readonly InventoryEntry[] = []

type WireRequest = { method: string; params: unknown; golden: string }

function wireRequests(): WireRequest[] {
  const seen = new Map<string, WireRequest>()
  for (const { id } of derivedGoldens(manifest)) {
    for (const checkpoint of readGolden(directory, id).recording.checkpoints) {
      const payloads = checkpoint.observation.payloads
      for (const payload of Array.isArray(payloads) ? payloads : []) {
        const json =
          payload && typeof payload === 'object' && 'json' in payload ? payload.json : undefined
        if (typeof json !== 'string') {
          continue
        }
        const frame: unknown = JSON.parse(json)
        if (!frame || typeof frame !== 'object' || !('method' in frame)) {
          continue
        }
        const method = String(frame.method)
        const params = 'params' in frame ? frame.params : undefined
        const key = `${method}\0${JSON.stringify(params)}`
        if (!seen.has(key)) {
          seen.set(key, { method, params, golden: id })
        }
      }
    }
  }
  return [...seen.values()]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Paths present in what was sent and absent from what the handler receives. */
function strippedPaths(sent: unknown, parsed: unknown, path = ''): string[] {
  if (Array.isArray(sent) && Array.isArray(parsed)) {
    return sent.flatMap((entry, index) => strippedPaths(entry, parsed[index], `${path}[${index}]`))
  }
  if (!isPlainObject(sent) || !isPlainObject(parsed)) {
    return []
  }
  return Object.keys(sent).flatMap((key) =>
    key in parsed ? strippedPaths(sent[key], parsed[key], `${path}.${key}`) : [`${path}.${key}`]
  )
}

function isEmptyParams(params: unknown): boolean {
  return (
    params === undefined ||
    params === null ||
    (isPlainObject(params) && !Object.keys(params).length)
  )
}

type InventoryEntry = { method: string; path: string; reason: string }

/** Every way the host would refuse, ignore or trim a request, plus inventory entries nothing uses. */
function contractProblems(
  requests: readonly WireRequest[],
  inventory: readonly InventoryEntry[]
): string[] {
  const unshared = new Set(RPC_METHODS_WITHOUT_SHARED_PARAMS)
  const problems: string[] = []
  const stripped = new Set<string>()
  for (const { method, params, golden } of requests) {
    const where = `${golden}: ${method} ${JSON.stringify(params)}`
    if (unshared.has(method)) {
      continue
    }
    if (!(method in RPC_PARAMS_BY_METHOD)) {
      problems.push(`${where}\n    the host has no method ${method}`)
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `method in RPC_PARAMS_BY_METHOD` was checked just above.
    const schema = RPC_PARAMS_BY_METHOD[method as keyof typeof RPC_PARAMS_BY_METHOD]
    if (schema === null) {
      // The dispatcher never reads params for these, so anything sent is dropped whole.
      if (!isEmptyParams(params)) {
        problems.push(`${where}\n    ${method} takes no params; the host ignores these`)
      }
      continue
    }
    const parsed = parseRpcRequestParams(
      { id: 'recorded', authToken: 'recorded', method, params },
      defineMethod({ name: method, params: schema, handler: () => null }),
      { runtimeId: 'recorded' }
    )
    if (parsed.error) {
      const refusal = parsed.error.ok ? '' : parsed.error.error.message
      problems.push(`${where}\n    the host refuses it: ${refusal}`)
      continue
    }
    for (const path of strippedPaths(params, parsed.value)) {
      if (inventory.some((entry) => entry.method === method && entry.path === path)) {
        stripped.add(`${method}\0${path}`)
      } else {
        problems.push(`${where}\n    the host drops ${path}`)
      }
    }
  }
  const stale = inventory
    .filter((entry) => !stripped.has(`${entry.method}\0${entry.path}`))
    .map((entry) => `${entry.method} ${entry.path}: no recorded request sends it any more`)
  return [...problems, ...stale]
}

describe('recorded requests against the host params contract', () => {
  it('sends only methods and params the host dispatcher accepts', () => {
    const requests = wireRequests()
    expect(requests.length).toBeGreaterThan(100)
    expect(contractProblems(requests, STRIPPED_KEY_INVENTORY)).toEqual([])
    // Reads and resolves every golden; a loaded CI worker takes longer than the default 5 s.
  }, 60_000)

  // The corpus has no instance of these today, so each rule is shown to fire on a made-up request.
  it('names an unknown method, a refusal, ignored params, a dropped key and a stale entry', () => {
    const request = (method: string, params: unknown): WireRequest => ({
      method,
      params,
      golden: 'made-up'
    })
    const problems = contractProblems(
      [
        request('nothing.here', {}),
        request('worktree.activate', {}),
        request('preflight.detectAgents', { verbose: true }),
        request('terminal.close', { terminal: 'term-1', extra: 1 })
      ],
      [{ method: 'terminal.close', path: '.gone', reason: 'made up' }]
    )
    expect(problems).toEqual([
      expect.stringContaining('the host has no method nothing.here'),
      expect.stringContaining('the host refuses it'),
      expect.stringContaining('preflight.detectAgents takes no params; the host ignores these'),
      expect.stringContaining('the host drops .extra'),
      'terminal.close .gone: no recorded request sends it any more'
    ])
  })
})
