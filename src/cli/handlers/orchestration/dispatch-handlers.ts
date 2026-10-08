import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { orchestrationMigrationData } from '../../../shared/orchestration-rpc-contract'
import { DISPATCH_DELIVERY_WITHOUT_INJECT_MESSAGE } from '../../../shared/orchestration-busy-delivery'
import { getOptionalBusyDeliveryFlag } from './busy-delivery-flag'
import { callOrchestrationMutation } from './mutation-request'
import { isDevCliInvocation } from './runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import { injectedSessionAddress } from '../../../shared/agent-session-caller-env'

const CHAT_TASK_DELIVERY_WORDS: ReadonlyMap<unknown, string> = new Map([
  ['accepted', 'sent'],
  ['pending', 'handed to the chat; not taken yet'],
  ['queued', 'queued in the chat']
])

/** Unknown arms from a newer runtime print nothing extra. */
function chatTaskDeliverySuffix(delivery: unknown): string {
  const words = CHAT_TASK_DELIVERY_WORDS.get(delivery)
  return words ? ` (task ${words})` : ''
}

export const ORCHESTRATION_DISPATCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration dispatch': async ({ flags, client, cwd, json }) => {
    const delivery = getOptionalBusyDeliveryFlag(flags)
    if (delivery && !flags.has('inject')) {
      throw new RuntimeClientError('invalid_argument', DISPATCH_DELIVERY_WITHOUT_INJECT_MESSAGE)
    }
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const dryRun = flags.has('dry-run') ? true : undefined
    const returnPreamble = flags.has('return-preamble') ? true : undefined
    // Why: --to is only required for non-dry-run; the RPC handler re-enforces.
    const to = dryRun ? getOptionalStringFlag(flags, 'to') : getRequiredStringFlag(flags, 'to')
    const result = await callOrchestrationMutation<{
      dispatch: { id: string; task_id: string; status: string } | null
      injected?: boolean
      /** How a chat assignee took the task; absent for a terminal or an older runtime. */
      delivery?: unknown
      dryRun?: boolean
      preamble?: string
    }>(client, flags, 'orchestration.dispatch', {
      task: getRequiredStringFlag(flags, 'task'),
      run: getOptionalStringFlag(flags, 'run'),
      to,
      from,
      inject: flags.has('inject') ? true : undefined,
      delivery,
      dryRun,
      returnPreamble,
      devMode: isDevCliInvocation()
    })
    printResult(result, json, (value) => {
      if (value.dryRun) {
        return value.preamble ?? ''
      }
      const base = `Dispatched ${value.dispatch?.task_id} -> ${value.dispatch?.id} [${value.dispatch?.status}]${chatTaskDeliverySuffix(value.delivery)}`
      return value.preamble ? `${base}\n\n--- Preamble ---\n${value.preamble}` : base
    })
  }
}

export const ORCHESTRATION_DISPATCH_INSPECTION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration dispatch-show': async ({ flags, client, cwd, json }) => {
    const showPreamble = flags.has('preamble') ? true : undefined
    // Why: a preview must embed the same real coordinator handle as an actual dispatch. Its --from
    // only fills preview text and names no caller, so it passes through unfenced.
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
    printResult(result, json, (value) => {
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
