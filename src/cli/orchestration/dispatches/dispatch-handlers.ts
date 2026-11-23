import type { CommandHandler } from '../../dispatch/dispatch'
import { printOrchestrationReceipt } from '../agent-view'
import { withReceiptNext } from '../receipt-next-text'
import { describeDispatchTurnStart, type DispatchReceipt } from './dispatch-turn-start'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../arguments/flags'
import { RuntimeClientError } from '../../runtime/connection/types'
import { orchestrationMigrationData } from '../../../shared/orchestration/orchestration-rpc-contract'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { isDevCliInvocation } from '../recovery/runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from '../identity/terminal-identity'
import { injectedSessionAddress } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'

export const ORCHESTRATION_DISPATCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration dispatch': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const dryRun = flags.has('dry-run') ? true : undefined
    const returnPreamble = flags.has('return-preamble') ? true : undefined
    const to = dryRun ? getOptionalStringFlag(flags, 'to') : getRequiredStringFlag(flags, 'to')
    const result = await callOrchestrationMutation<DispatchReceipt>(
      client,
      flags,
      'orchestration.dispatch',
      {
        task: getRequiredStringFlag(flags, 'task'),
        run: getOptionalStringFlag(flags, 'run'),
        to,
        from,
        inject: flags.has('inject') ? true : undefined,
        dryRun,
        returnPreamble,
        devMode: isDevCliInvocation()
      }
    )
    const receipt = describeDispatchTurnStart(result.result)
    printOrchestrationReceipt({ ...result, result: receipt }, { flags, json }, (value) => {
      if (value.dryRun) {
        return value.preamble ?? ''
      }
      const turnStart = value.turnStart ? `, turn start ${value.turnStart}` : ''
      const base = `Dispatched ${value.dispatch?.task_id} -> ${value.dispatch?.id} [${value.dispatch?.status}]${turnStart}`
      return withReceiptNext(
        value.preamble ? `${base}\n\n--- Preamble ---\n${value.preamble}` : base,
        value
      )
    })
  }
}

export const ORCHESTRATION_DISPATCH_INSPECTION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration dispatch-show': async ({ flags, client, cwd, json }) => {
    const showPreamble = flags.has('preamble') ? true : undefined
    // --from fills preview text rather than asserting caller identity, so it is intentionally unfenced.
    const from = showPreamble
      ? (getOptionalStringFlag(flags, 'from') ??
        injectedSessionAddress() ??
        (await resolveCoordinatorTerminalHandle(flags, cwd, client)))
      : undefined
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string } | null
      preamble?: string
    }>('orchestration.dispatchShow', {
      task: getRequiredStringFlag(flags, 'task'),
      preamble: showPreamble,
      from,
      devMode: isDevCliInvocation()
    })
    printOrchestrationReceipt(result, { flags, json }, (value) => {
      if (value.preamble && showPreamble) {
        return value.preamble
      }
      if (!value.dispatch) {
        return 'No dispatch context found.'
      }
      return `${value.dispatch.id} task=${value.dispatch.task_id} [${value.dispatch.status}]`
    })
  },

  'orchestration coordinator-start': async () => {
    throw new RuntimeClientError(
      'orchestration_migration_required',
      'The legacy automatic coordinator command is retired. No effects were applied.',
      orchestrationMigrationData('command_retired')
    )
  },

  'orchestration coordinator-stop': async () => {
    throw new RuntimeClientError(
      'orchestration_migration_required',
      'The legacy automatic coordinator command is retired. No effects were applied.',
      orchestrationMigrationData('command_retired')
    )
  }
}
