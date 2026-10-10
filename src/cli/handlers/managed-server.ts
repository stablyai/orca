/**
 * `orca environment status|update|rollback|recover|stop|forget|cancel-stop`: the Managed servers
 * actions over runtime RPC. Each call is gated on the runtime's managedServer.v1 capability, and
 * an older runtime's method_not_found reads the same as a missing capability.
 */
import type {
  OrcadManagedCancelStopResult,
  OrcadManagedDeployResult,
  OrcadManagedForgetResult,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus,
  OrcadManagedStopResult
} from '../../shared/orcad-managed-runtime'
import { ORCAD_RECOVERY_CHANGED_STATE_CODE } from '../../shared/orcad-managed-runtime'
import { MANAGED_SERVER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { formatManagedServerStatus } from './managed-server-format'
import { reportAfterClosedConnection } from './managed-server-reconnect'

const UNSUPPORTED_MESSAGE =
  'This Orca runtime cannot manage servers over SSH. Run this on the computer whose Orca desktop app deployed the server, after updating Orca there.'

// Why 20 minutes: the desktop runs the whole action inline, and a Windows runtime promotion (5 min)
// plus a readiness wait (5 min) on a slow host already outlast the 60 s RPC default.
export const MANAGED_SERVER_ACTION_TIMEOUT_MS = 20 * 60_000
const READ_ONLY_METHODS = new Set(['managedServer.status'])

function unsupported(): RuntimeClientError {
  return new RuntimeClientError('incompatible_runtime', UNSUPPORTED_MESSAGE)
}

async function callManagedServer<TResult>(
  { client }: HandlerContext,
  method: string,
  params: Record<string, unknown>
): Promise<RuntimeRpcSuccess<TResult>> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(MANAGED_SERVER_RUNTIME_CAPABILITY)) {
    throw unsupported()
  }
  const readOnly = READ_ONLY_METHODS.has(method)
  try {
    return await client.call<TResult>(
      method,
      params,
      readOnly ? undefined : { timeoutMs: MANAGED_SERVER_ACTION_TIMEOUT_MS }
    )
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw unsupported()
    }
    // Why not a failure: the desktop keeps running the action after this client stops waiting.
    if (!readOnly && error instanceof RuntimeClientError && error.code === 'runtime_timeout') {
      throw new RuntimeClientError(
        'managed_server_in_progress',
        'Stopped waiting, but the desktop may still be running this action. Check `orca environment status` before retrying.'
      )
    }
    throw error
  }
}

/** Null once the restart's outcome was reported from status instead. */
async function callExpectingRestart<TResult>(
  context: HandlerContext,
  method: string,
  params: { selector: string } & Record<string, unknown>
): Promise<RuntimeRpcSuccess<TResult> | null> {
  try {
    return await callManagedServer<TResult>(context, method, params)
  } catch (error) {
    if (!(error instanceof RuntimeClientError) || error.code !== 'runtime_unavailable') {
      throw error
    }
    await reportAfterClosedConnection(context, { selector: params.selector })
    return null
  }
}

function selectorOf(context: HandlerContext): { selector: string } {
  return { selector: getRequiredStringFlag(context.flags, 'environment') }
}

type Outcome = { outcome: string; code?: string; reason?: string }

/**
 * Prints a result whose outcome is in `settled`; throws any other so scripts see a non-zero exit.
 * Why an allow-list: an outcome a newer desktop adds must fail loudly, not print `undefined`.
 */
function report<TResult extends Outcome, TSettled extends TResult['outcome']>(
  response: RuntimeRpcSuccess<TResult>,
  json: boolean,
  settled: readonly TSettled[],
  done: (result: Extract<TResult, { outcome: TSettled }>) => string,
  nextStep?: (result: TResult) => string | null
): void {
  const result = response.result
  if (!isSettled(result, settled)) {
    const reason = result.reason ?? `The managed Orca server action was ${result.outcome}.`
    const step = nextStep?.(result)
    throw new RuntimeClientError(
      `managed_server_${result.outcome}`,
      step ? `${reason} ${step}` : reason,
      result
    )
  }
  printResult({ ...response, result }, json, done)
}

function isSettled<TResult extends Outcome, TSettled extends TResult['outcome']>(
  result: TResult,
  settled: readonly TSettled[]
): result is Extract<TResult, { outcome: TSettled }> {
  return settled.some((outcome) => outcome === result.outcome)
}

export const MANAGED_SERVER_HANDLERS: Record<string, CommandHandler> = {
  'environment status': async (context) => {
    const response = await callManagedServer<OrcadManagedRuntimeStatus>(
      context,
      'managedServer.status',
      selectorOf(context)
    )
    printResult(response, context.json, formatManagedServerStatus)
  },
  'environment update': async (context) => {
    const params = { ...selectorOf(context), force: context.flags.get('force') === true }
    const response = await callExpectingRestart<OrcadManagedDeployResult>(
      context,
      'managedServer.update',
      params
    )
    if (!response) {
      return
    }
    report(response, context.json, ['created', 'updated', 'already-current'], (result) =>
      result.outcome === 'already-current'
        ? `Already on ${result.activeVersion}.`
        : `Updated ${result.environment.name} to ${result.activeVersion}.`
    )
  },
  'environment rollback': async (context) => {
    const response = await callExpectingRestart<OrcadManagedRollbackResult>(
      context,
      'managedServer.rollback',
      selectorOf(context)
    )
    if (!response) {
      return
    }
    report(
      response,
      context.json,
      ['rolled-back'],
      (result) => `Rolled ${result.environment.name} back to ${result.activeVersion}.`
    )
  },
  'environment recover': async (context) => {
    const params = selectorOf(context)
    const acceptChangedState = context.flags.get('accept-changed-state') === true
    if (acceptChangedState && context.flags.get('yes') !== true) {
      throw new RuntimeClientError(
        'confirmation_required',
        `Restoring ${params.selector}'s prelaunch snapshot discards what the rejected build changed. Re-run with --yes to confirm.`
      )
    }
    const response = await callManagedServer<OrcadManagedRecoveryResult>(
      context,
      'managedServer.recover',
      acceptChangedState ? { ...params, acceptChangedState } : params
    )
    report(
      response,
      context.json,
      ['recovered', 'none'],
      (result) =>
        result.outcome === 'recovered'
          ? `Recovered ${result.environment.name} (${result.resolution}); active version ${result.activeVersion ?? 'none'}.`
          : 'Nothing to recover.',
      (result) =>
        !acceptChangedState && 'code' in result && result.code === ORCAD_RECOVERY_CHANGED_STATE_CODE
          ? 'To restore it from the CLI, re-run with --accept-changed-state --yes.'
          : null
    )
  },
  'environment stop': async (context) => {
    const params = selectorOf(context)
    if (context.flags.get('yes') !== true) {
      throw new RuntimeClientError(
        'confirmation_required',
        `Stopping ${params.selector} ends its terminals and unlinks it from this machine. Re-run with --yes to confirm.`
      )
    }
    const response = await callManagedServer<OrcadManagedStopResult>(
      context,
      'managedServer.stop',
      params
    )
    report(
      response,
      context.json,
      ['unlinked'],
      () => `Stopped ${params.selector} and unlinked it from this machine.`
    )
  },
  'environment forget': async (context) => {
    const params = selectorOf(context)
    if (context.flags.get('yes') !== true) {
      throw new RuntimeClientError(
        'confirmation_required',
        `Forgetting ${params.selector} unlinks it from this machine without stopping it on its host. Re-run with --yes to confirm.`
      )
    }
    const response = await callManagedServer<OrcadManagedForgetResult>(
      context,
      'managedServer.forget',
      params
    )
    report(
      response,
      context.json,
      ['forgotten'],
      () =>
        `Unlinked ${params.selector} from this machine. Its host was not contacted, so orcad may still be running there.`
    )
  },
  'environment cancel-stop': async (context) => {
    const response = await callManagedServer<OrcadManagedCancelStopResult>(
      context,
      'managedServer.cancelStop',
      selectorOf(context)
    )
    report(response, context.json, ['canceled', 'already-stopped', 'none'], (result) => {
      switch (result.outcome) {
        case 'canceled':
          return `Stop withdrawn; the server keeps serving ${result.activeVersion}.`
        case 'already-stopped':
          return 'orcad had already exited. Run `orca environment stop --yes` to unlink it.'
        case 'none':
          return 'No stop is pending.'
      }
    })
  }
}
