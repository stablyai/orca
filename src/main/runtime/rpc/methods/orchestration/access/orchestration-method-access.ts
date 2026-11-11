/** One access declaration on every orchestration method, checked where its handler runs;
 * the registry refuses an orchestration method without one. */
import { types } from 'node:util'
import type { ZodType } from 'zod'
import type { RpcContext, RpcTypedMethod, RpcTypedStreamingMethod } from '../../../core'
import {
  checkPeerAccess,
  refusePeerAddressClaim,
  refuseServerCallFromPeerRun
} from './peer-run-access'

type ParsedParams<TSchema extends ZodType | null> = TSchema extends ZodType
  ? TSchema['_output']
  : void

/** `localOnly` methods act on this Orca as a whole (reset, Run binding, the federation wire). */
export type OrchestrationAccessKind = 'reads' | 'writes' | 'localOnly'

/** What a target field names; a terminal, pane or session field naming a worker is `worker`,
 * and send's JSON `payload` names the Dispatch its `dispatchId` selects. */
export type OrchestrationSubjectKind =
  | 'dispatch'
  | 'task'
  | 'message'
  | 'gate'
  | 'run'
  | 'worker'
  | 'party'
  | 'session'
  | 'request'
  | 'conversation'

/** A field naming who is calling, as opposed to what the call acts on. */
export type OrchestrationCallerField = 'from' | 'terminal' | 'callerTerminalHandle'

/** The pane key a caller sends with its caller field, which only its own host can fill. */
export type OrchestrationCallerPaneField = 'terminalPaneKey' | 'senderPaneKey'

type FieldOf<P> = P extends object ? Extract<keyof P, string> : never

export type OrchestrationAccessRuleInput<P> = {
  params: P
  ctx: RpcContext
  /** The declared caller field's value. */
  caller: string | undefined
}

/** A named function holding a method's own authorization; its grant is what the handler acts with. */
export type OrchestrationAccessRule<P, G> = (input: OrchestrationAccessRuleInput<P>) => G

export type OrchestrationMethodAccess<P, G> = {
  readonly kind: OrchestrationAccessKind
  readonly caller?: Extract<FieldOf<P>, OrchestrationCallerField>
  readonly callerPane?: Extract<FieldOf<P>, OrchestrationCallerPaneField>
  /** The field that sends the call on to a paired server (`--on`). */
  readonly server?: Extract<FieldOf<P>, 'on'>
  /** Every field naming something the call acts on, kept apart from the caller field. */
  readonly targets: Readonly<Partial<Record<FieldOf<P>, OrchestrationSubjectKind>>>
  /** A read returning a collection; a narrower caller restricts its query, never its page. */
  readonly collection?: true
  readonly rule?: OrchestrationAccessRule<P, G>
}

/** The erased declaration the registry keeps for the dispatcher and the session-caller binding. */
export type OrchestrationMethodAccessDeclaration = {
  readonly kind: OrchestrationAccessKind
  readonly caller?: OrchestrationCallerField
  readonly callerPane?: OrchestrationCallerPaneField
  readonly server?: 'on'
  readonly targets: Readonly<Partial<Record<string, OrchestrationSubjectKind>>>
  readonly collection?: true
  readonly rule?: OrchestrationAccessRule<never, unknown>
}

/** The one access check: every caller on this Orca is held to the method's own rule, and a paired
 *  Orca also to the Run it coordinates here. Returns the params the method runs with and its grant. */
export function checkOrchestrationAccess<P, G>(
  access: OrchestrationMethodAccess<P, G>,
  params: P,
  ctx: RpcContext
): { params: P; grant: G } {
  const caller = ctx.orchestrationCaller
  if (caller?.kind !== 'peer') {
    refusePeerAddressClaim(access.caller && fieldValue(access.caller, params))
    refusePeerAddressClaim(access.callerPane && fieldValue(access.callerPane, params))
  }
  const scoped =
    caller?.kind === 'peer'
      ? checkPeerAccess(access, params, ctx.runtime.getOrchestrationDb(), caller)
      : params
  if (access.server && fieldValue(access.server, scoped) !== undefined) {
    refuseServerCallFromPeerRun(ctx, declaredCaller(access.caller, scoped))
  }
  if (!access.rule) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: G defaults to undefined exactly when a method declares no rule.
    return { params: scoped, grant: undefined as G }
  }
  return {
    params: scoped,
    grant: access.rule({ params: scoped, ctx, caller: declaredCaller(access.caller, scoped) })
  }
}

function declaredCaller<P>(
  field: Extract<FieldOf<P>, OrchestrationCallerField> | undefined,
  params: P
): string | undefined {
  return field === undefined ? undefined : fieldValue(field, params)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function fieldValue(field: string, params: unknown): string | undefined {
  const value: unknown = isRecord(params) ? params[field] : undefined
  return typeof value === 'string' ? value : undefined
}

type RpcHandler = (...args: never[]) => unknown

// Each handler these factories built, with the declaration it checks; the registry refuses any other pairing.
const checkedHandlers = new WeakMap<RpcHandler, OrchestrationMethodAccessDeclaration>()

/** Whether this handler runs the check for exactly this registered declaration. */
export function runsOrchestrationAccessCheck(method: {
  readonly handler: RpcHandler
  readonly orchestrationAccess?: OrchestrationMethodAccessDeclaration
}): boolean {
  const declared = method.orchestrationAccess
  return declared !== undefined && checkedHandlers.get(method.handler) === declared
}

/** A promise-returning handler's refusal or replay stays a rejected or resolved promise, a sync handler's a throw. */
function checked<A extends unknown[], R>(
  handler: RpcHandler,
  access: OrchestrationMethodAccessDeclaration,
  run: (...args: A) => R
): (...args: A) => R {
  const promised = types.isAsyncFunction(handler)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only an async handler's wrapper is async, so R is already a promise of the same awaited value.
  const wrapped = promised ? ((async (...args: A) => await run(...args)) as (...args: A) => R) : run
  checkedHandlers.set(wrapped, access)
  return wrapped
}

type OrchestrationMethodSpec<
  TName extends `orchestration.${string}`,
  TSchema extends ZodType | null,
  TResult,
  G
> = Omit<RpcTypedMethod<TName, TSchema, TResult>, 'handler'> & {
  readonly access: OrchestrationMethodAccess<ParsedParams<TSchema>, G>
  /** How the executor's observation of an accepted call's replay redelivers its nudge; it runs
   * before any rule, since an accepted call is never authorized again. Undefined: nothing to redeliver. */
  readonly replay?: (
    params: ParsedParams<TSchema>,
    ctx: RpcContext
  ) => { receipt: unknown } | undefined
  readonly handler: (params: ParsedParams<TSchema>, ctx: RpcContext, access: G) => TResult
}

export type OrchestrationMethod<
  TName extends string,
  TSchema extends ZodType | null,
  TResult
> = RpcTypedMethod<TName, TSchema, TResult> & {
  readonly orchestrationAccess: OrchestrationMethodAccessDeclaration
}

/** Every orchestration method is defined here, so its access is checked before its handler acts. */
export function defineOrchestrationMethod<
  TName extends `orchestration.${string}`,
  TSchema extends ZodType | null,
  TResult,
  G = undefined
>(
  spec: OrchestrationMethodSpec<TName, TSchema, TResult, G>
): OrchestrationMethod<TName, TSchema, TResult> {
  const { access, replay, handler, ...method } = spec
  const declaration: OrchestrationMethodAccessDeclaration = access
  return {
    ...method,
    orchestrationAccess: declaration,
    handler: checked(handler, declaration, (params: ParsedParams<TSchema>, ctx: RpcContext) => {
      const replayed = ctx.replayedMutationReceipt === undefined ? undefined : replay?.(params, ctx)
      if (replayed) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a replay returns the receipt this handler produced when the call was accepted; a promise-returning handler's wrapper is async.
        return replayed.receipt as TResult
      }
      const checked = checkOrchestrationAccess(access, params, ctx)
      return handler(checked.params, ctx, checked.grant)
    })
  }
}

export type OrchestrationStreamingMethod<
  TName extends string,
  TSchema extends ZodType | null
> = RpcTypedStreamingMethod<TName, TSchema> & {
  readonly orchestrationAccess: OrchestrationMethodAccessDeclaration
}

export function defineOrchestrationStreamingMethod<
  TName extends `orchestration.${string}`,
  TSchema extends ZodType | null,
  G = undefined
>(
  spec: Omit<RpcTypedStreamingMethod<TName, TSchema>, 'stream' | 'handler'> & {
    readonly access: OrchestrationMethodAccess<ParsedParams<TSchema>, G>
    readonly handler: (
      params: ParsedParams<TSchema>,
      ctx: RpcContext,
      emit: (result: unknown) => void,
      access: G
    ) => Promise<void>
  }
): OrchestrationStreamingMethod<TName, TSchema> {
  const { access, handler, ...method } = spec
  const declaration: OrchestrationMethodAccessDeclaration = access
  return {
    ...method,
    stream: true,
    orchestrationAccess: declaration,
    // Streaming methods have no replay hook: the executor never observes a streaming receipt.
    handler: checked(
      handler,
      declaration,
      (params: ParsedParams<TSchema>, ctx: RpcContext, emit: (result: unknown) => void) => {
        const checked = checkOrchestrationAccess(access, params, ctx)
        return handler(checked.params, ctx, emit, checked.grant)
      }
    )
  }
}
