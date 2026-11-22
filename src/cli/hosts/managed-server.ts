import type {
  OrcadManagedCancelStopResult,
  OrcadManagedDeployResult,
  OrcadManagedForgetResult,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus,
  OrcadManagedStopResult
} from '../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import {
  isOrcadUncountedTerminalsDeferral,
  ORCAD_RECOVERY_CHANGED_STATE_CODE
} from '../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { formatManagedServerStatus } from './managed-server-format'
import { callExpectingRestart, callManagedServer } from './managed-server-request'

const END_SERVER_TERMINALS_HINT =
  'To allow a restart with an unknown terminal count, re-run with --force --end-server-terminals to confirm that any terminals the server runs itself will end if it restarts.'

function selectorOf(context: HandlerContext): { selector: string } {
  return { selector: getRequiredStringFlag(context.flags, 'environment') }
}

type Outcome = { outcome: string; code?: string; reason?: string }

/** Reject unknown outcomes so newer-server responses cannot silently print undefined. */
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
    const force = context.flags.get('force') === true
    const endServerTerminals = context.flags.get('end-server-terminals') === true
    if (endServerTerminals && !force) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--end-server-terminals only applies with --force. Re-run with --force --end-server-terminals.'
      )
    }
    const params = {
      ...selectorOf(context),
      force,
      ...(endServerTerminals ? { endServerTerminals } : {})
    }
    const response = await callExpectingRestart<OrcadManagedDeployResult>(
      context,
      'managedServer.update',
      params,
      force && !endServerTerminals
    )
    report(
      response,
      context.json,
      ['created', 'updated', 'already-current'],
      (result) =>
        result.outcome === 'already-current'
          ? `Already on ${result.activeVersion}.`
          : `Updated ${result.environment.name} to ${result.activeVersion}.`,
      (result) =>
        !endServerTerminals &&
        result.outcome === 'deferred' &&
        'code' in result &&
        result.forceable === true &&
        isOrcadUncountedTerminalsDeferral(result.code)
          ? END_SERVER_TERMINALS_HINT
          : null
    )
  },
  'environment rollback': async (context) => {
    const response = await callExpectingRestart<OrcadManagedRollbackResult>(
      context,
      'managedServer.rollback',
      selectorOf(context)
    )
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
      () =>
        `Stopped ${params.selector}, unlinked it from this machine and disconnected its SSH host.`
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
        `Unlinked ${params.selector} from this machine and disconnected its SSH host. The host was not contacted, so orcad may still be running there; connect the host to set its server up again.`
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
