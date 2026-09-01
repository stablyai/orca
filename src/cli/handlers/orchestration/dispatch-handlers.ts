import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { orchestrationMigrationData } from '../../../shared/orchestration-rpc-contract'
import { callOrchestrationMutation } from './mutation-request'
import { isDevCliInvocation } from './runtime-compatibility'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_DISPATCH_HANDLER: Record<string, CommandHandler> = {
  'orchestration dispatch': async ({ flags, client, cwd, json }) => {
    const from = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const dryRun = flags.has('dry-run') ? true : undefined
    const returnPreamble = flags.has('return-preamble') ? true : undefined
    // Why: --to is only required for non-dry-run; the RPC handler re-enforces.
    const to = dryRun ? getOptionalStringFlag(flags, 'to') : getRequiredStringFlag(flags, 'to')
    const result = await callOrchestrationMutation<{
      dispatch: { id: string; task_id: string; status: string } | null
      injected?: boolean
      dryRun?: boolean
      preamble?: string
    }>(client, flags, 'orchestration.dispatch', {
      task: getRequiredStringFlag(flags, 'task'),
      run: getOptionalStringFlag(flags, 'run'),
      to,
      from,
      inject: flags.has('inject') ? true : undefined,
      dryRun,
      returnPreamble,
      devMode: isDevCliInvocation()
    })
    printResult(result, json, (value) => {
      if (value.dryRun) {
        return value.preamble ?? ''
      }
      const base = `Dispatched ${value.dispatch?.task_id} -> ${value.dispatch?.id} [${value.dispatch?.status}]`
      return value.preamble ? `${base}\n\n--- Preamble ---\n${value.preamble}` : base
    })
  }
}

export const ORCHESTRATION_DISPATCH_INSPECTION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration dispatch-show': async ({ flags, client, cwd, json }) => {
    if (flags.has('raw')) {
      const result = await client.call<{
        dispatch: {
          id: string
          task_id: string
          status: string
          agent_launch_failure: string | null
        } | null
      }>('orchestration.dispatchShowRaw', {
        task: getRequiredStringFlag(flags, 'task')
      })
      printResult(result, json, (value) => {
        if (!value.dispatch) {
          return 'No dispatch context found.'
        }
        const failure = value.dispatch.agent_launch_failure
          ? ` failure=${value.dispatch.agent_launch_failure}`
          : ''
        return `${value.dispatch.id} task=${value.dispatch.task_id} [${value.dispatch.status}]${failure}`
      })
      return
    }
    const showPreamble = flags.has('preamble') ? true : undefined
    // Why: a preview must embed the same real coordinator handle as an actual dispatch.
    const from = showPreamble
      ? await resolveCoordinatorTerminalHandle(flags, cwd, client)
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

  'orchestration dispatch-forget': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string } | null
    }>('orchestration.dispatchForget', {
      task: getRequiredStringFlag(flags, 'task'),
      expectedFailureId: getOptionalStringFlag(flags, 'expected-failure-id'),
      run: getOptionalStringFlag(flags, 'run'),
      from: await resolveCoordinatorTerminalHandle(flags, cwd, client)
    })
    printResult(result, json, (value) => {
      if (!value.dispatch) {
        return 'No dispatch context found.'
      }
      return `Forgot dispatch ${value.dispatch.id} task=${value.dispatch.task_id} [${value.dispatch.status}]. Task is blocked; retry with: orca orchestration task-update --id ${value.dispatch.task_id} --status ready`
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
