// Why: this is the single boundary between raw RPC frames and the OrcaRuntimeService.
// Keeping the schema, handler, and result type attached to one object makes the
// CLI-facing contract greppable and lets the dispatcher verify every payload
// against the same shape the handler consumed during development.
import { ZodError, type ZodType } from 'zod'
import type { OrcaRuntimeService } from '../orca-runtime'

export type RpcEnvelopeMeta = {
  runtimeId: string
}

export type RpcSuccess = {
  id: string
  ok: true
  result: unknown
  _meta: RpcEnvelopeMeta
}

export type RpcFailure = {
  id: string
  ok: false
  error: {
    code: string
    message: string
    data?: unknown
  }
  _meta: RpcEnvelopeMeta
}

export type RpcResponse = RpcSuccess | RpcFailure

export type RpcRequest = {
  id: string
  authToken: string
  method: string
  params?: unknown
}

export type RpcContext = {
  runtime: OrcaRuntimeService
}

export type RpcHandler<TParams> = (params: TParams, ctx: RpcContext) => Promise<unknown> | unknown

// Why: defineMethod preserves the inferred param type locally so each handler
// is fully typed, but the erased `RpcMethod` form is what the dispatcher
// actually stores. The erasure lives in one cast inside defineMethod rather
// than in every method file, which is the tradeoff for the variance problem
// of `RpcHandler` being contravariant in its param type.
export type RpcMethod = {
  readonly name: string
  readonly params: ZodType | null
  readonly handler: (params: unknown, ctx: RpcContext) => Promise<unknown> | unknown
}

type DefineMethodSpec<TSchema extends ZodType | null> = {
  name: string
  params: TSchema
  handler: RpcHandler<TSchema extends ZodType ? TSchema['_output'] : void>
}

export function defineMethod<TSchema extends ZodType | null>(
  spec: DefineMethodSpec<TSchema>
): RpcMethod {
  return {
    name: spec.name,
    params: spec.params,
    handler: spec.handler as RpcMethod['handler']
  }
}

export type RpcRegistry = ReadonlyMap<string, RpcMethod>

export function buildRegistry(methods: readonly RpcMethod[]): RpcRegistry {
  const registry = new Map<string, RpcMethod>()
  for (const method of methods) {
    if (registry.has(method.name)) {
      throw new Error(`duplicate_rpc_method:${method.name}`)
    }
    registry.set(method.name, method)
  }
  return registry
}

export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidArgumentError'
  }
}

// Why: zod aggregates all failing fields into `issues`, but the CLI surfaces
// a single string to users. Pick the first issue's message so callers see a
// message that matches the original handler's `Missing terminal handle`-style
// phrasing (each schema supplies that literal message on its own constraint).
export function formatZodError(error: ZodError): string {
  const first = error.issues[0]
  return first?.message ?? 'invalid_argument'
}

export { ZodError }
