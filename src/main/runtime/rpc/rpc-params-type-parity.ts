import type {
  RpcMethodName,
  RpcParams
} from '../../../shared/rpc-contract/rpc-params-catalog.generated'
import type { RpcAnyMethodDeclaration } from './core'
import type { ALL_RPC_METHODS } from './methods'

type RegisteredMethod = (typeof ALL_RPC_METHODS)[number]

// These schemas reach into src/main and have no shared catalog entry.
type UncataloguedMethod = 'emulator.install' | 'orchestration.send' | 'orchestration.taskUpdate'

type IsAny<T> = 0 extends 1 & T ? true : false

type ParamsMatch<Host, Catalog> =
  IsAny<Host> extends true
    ? false
    : IsAny<Catalog> extends true
      ? false
      : [Host] extends [Catalog]
        ? [Catalog] extends [Host]
          ? true
          : false
        : false

// Distribute over declarations so each handler is checked, including streaming handlers.
type MismatchedMethod<Method extends RpcAnyMethodDeclaration> =
  Method extends RpcAnyMethodDeclaration
    ? Method['name'] extends RpcMethodName
      ? ParamsMatch<Parameters<Method['handler']>[0], RpcParams<Method['name']>> extends true
        ? never
        : Method['name']
      : Exclude<Method['name'], UncataloguedMethod>
    : never

type AssertNever<T extends never> = T

// Type-only gates belong in the node typecheck; runtime parsing is a separate contract.
export type RpcParamsTypeParity = AssertNever<MismatchedMethod<RegisteredMethod>>
export type RpcParamsUncataloguedMethods = AssertNever<
  Exclude<UncataloguedMethod, Exclude<RegisteredMethod['name'], RpcMethodName>>
>
