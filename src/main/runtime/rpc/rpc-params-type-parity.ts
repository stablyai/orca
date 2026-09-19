import type {
  RpcMethodName,
  RpcParams
} from '../../../shared/rpc-contract/rpc-params-catalog.generated'
import type { RpcAnyMethodDeclaration } from './core'
import type { ALL_RPC_METHODS } from './methods'

type RegisteredMethod = (typeof ALL_RPC_METHODS)[number]

// These schemas reach into src/main and have no shared catalog entry.
type UncataloguedMethod =
  | 'emulator.install'
  | 'orcad.migration.abortCatalog'
  | 'orcad.migration.catalogState'
  | 'orcad.migration.commitCatalog'
  | 'orcad.migration.importCatalog'
  | 'orcad.migration.stageCatalog'
  | 'orcad.terminalCensus'
  | 'orchestration.send'
  | 'orchestration.taskUpdate'
  | 'pty.ownershipTransfer.abortSource'
  | 'pty.ownershipTransfer.acknowledgeOutputSource'
  | 'pty.ownershipTransfer.attachSource'
  | 'pty.ownershipTransfer.capturedDestinationCapabilities'
  | 'pty.ownershipTransfer.commitSource'
  | 'pty.ownershipTransfer.controlSource'
  | 'pty.ownershipTransfer.grantSource'
  | 'pty.ownershipTransfer.inputSource'
  | 'pty.ownershipTransfer.inspectCapturedCatalogActivation'
  | 'pty.ownershipTransfer.inspectCapturedCatalogOutputCoverage'
  | 'pty.ownershipTransfer.preflightSource'
  | 'pty.ownershipTransfer.prepareCapturedDestination'
  | 'pty.ownershipTransfer.prepareSource'
  | 'pty.ownershipTransfer.publishSource'
  | 'pty.ownershipTransfer.rekeyReconnectSource'
  | 'pty.ownershipTransfer.replaySource'
  | 'pty.ownershipTransfer.retireCapturedSourceDelivery'
  | 'pty.ownershipTransfer.retireInputSource'
  | 'pty.ownershipTransfer.statusSource'
  | 'pty.ownershipTransfer.streamSource'

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
