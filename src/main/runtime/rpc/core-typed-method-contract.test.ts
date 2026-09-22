// The preserved types are the whole point of defineMethod, so they are asserted here: if a name
// widens to `string` or a result to `unknown`, these assertions fail at typecheck, not at runtime.
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  buildRegistry,
  defineMethod,
  defineStreamingMethod,
  eraseRpcMethods,
  isStreamingMethod,
  type RpcContext,
  type RpcMethod,
  type RpcStreamingMethod
} from './core'
import type { ALL_RPC_METHODS } from './methods'
import { STATUS_METHODS } from './methods/status'
import type { HOST_CAPABILITY_METHODS } from './methods/host-capabilities'

const ProbeParams = z.object({ id: z.string(), count: z.number().optional() })

const probe = defineMethod({
  name: 'test.typedProbe',
  params: ProbeParams,
  handler: (params) => ({ id: params.id, count: params.count ?? 0 })
})

const schemalessProbe = defineMethod({
  name: 'test.schemalessProbe',
  params: null,
  handler: () => ['a', 'b']
})

const streamingProbe = defineStreamingMethod({
  name: 'test.streamingProbe',
  params: ProbeParams,
  handler: async (params, _ctx, emit) => {
    emit(params.id)
  }
})

type ByName<TMethods, TName extends string> = Extract<TMethods, { name: TName }>

describe('defineMethod preserves the declared contract', () => {
  it('keeps the literal method name', () => {
    expectTypeOf(probe.name).toEqualTypeOf<'test.typedProbe'>()
    expectTypeOf(streamingProbe.name).toEqualTypeOf<'test.streamingProbe'>()
    expect(probe.name).toBe('test.typedProbe')
  })

  it('keeps the producer result type', () => {
    expectTypeOf(probe.handler).returns.toEqualTypeOf<{ id: string; count: number }>()
    expectTypeOf(schemalessProbe.handler).returns.toEqualTypeOf<string[]>()
  })

  it('infers parsed params from the schema, and `void` without one', () => {
    expectTypeOf(probe.handler)
      .parameter(0)
      .toEqualTypeOf<{ id: string; count?: number | undefined }>()
    expectTypeOf(schemalessProbe.handler).parameter(0).toEqualTypeOf<void>()
    expectTypeOf(streamingProbe.handler)
      .parameter(0)
      .toEqualTypeOf<{ id: string; count?: number | undefined }>()
    expectTypeOf(probe.params).toEqualTypeOf<typeof ProbeParams>()
  })

  it('keeps a registered method addressable by its literal name', () => {
    type StatusGet = ByName<(typeof STATUS_METHODS)[number], 'status.get'>
    type ListDistros = ByName<(typeof HOST_CAPABILITY_METHODS)[number], 'host.wsl.listDistros'>
    expectTypeOf<StatusGet>().not.toBeNever()
    expectTypeOf<StatusGet['handler']>().returns.toExtend<{ runtimeId: string }>()
    expectTypeOf<ListDistros['handler']>().returns.toEqualTypeOf<Promise<string[]>>()
    // The manifest is the erasure boundary's input, so the literal names have to survive it too.
    expectTypeOf<ByName<(typeof ALL_RPC_METHODS)[number], 'status.get'>>().not.toBeNever()
  })
})

describe('eraseRpcMethods is the registry boundary', () => {
  it('erases to the shape the dispatcher calls, keeping the streaming split', () => {
    expectTypeOf(eraseRpcMethods([probe])).toEqualTypeOf<readonly RpcMethod[]>()
    expectTypeOf(eraseRpcMethods([streamingProbe])).toEqualTypeOf<readonly RpcStreamingMethod[]>()
    expectTypeOf(eraseRpcMethods(STATUS_METHODS)).toEqualTypeOf<readonly RpcMethod[]>()
    expectTypeOf(eraseRpcMethods([probe])[0]!.handler)
      .parameter(0)
      .toEqualTypeOf<unknown>()
  })

  it('returns the same methods, so nothing about the runtime value changes', () => {
    const erased = eraseRpcMethods([probe, streamingProbe])

    expect(erased[0]).toBe(probe)
    expect(erased[1]).toBe(streamingProbe)
  })

  it('produces methods the registry accepts and the dispatcher can invoke', async () => {
    const registry = buildRegistry([probe, streamingProbe, ...STATUS_METHODS])
    const registered = registry.get('test.typedProbe')

    expect(registered).toBe(probe)
    expect(registry.get('status.get')).toBe(STATUS_METHODS[0])
    expect(isStreamingMethod(registry.get('test.streamingProbe')!)).toBe(true)
    expect(registered && isStreamingMethod(registered)).toBe(false)
    // The dispatcher parses params itself and then calls the erased handler with `unknown`.
    const parsed: unknown = probe.params.parse({ id: 'a' })
    expect(
      registered && !isStreamingMethod(registered)
        ? await registered.handler(parsed, {} as RpcContext)
        : undefined
    ).toEqual({ id: 'a', count: 0 })
  })

  it('rejects a duplicate name before erasure hides it', () => {
    expect(() => buildRegistry([probe, probe])).toThrow('duplicate_rpc_method:test.typedProbe')
  })
})
