import type { CommandHandler } from '../../dispatch/dispatch'
import { getOptionalStringFlag } from '../../arguments/flags'
import { readTextOrFileFlag } from '../../arguments/command-body-input'
import { printResult } from '../../output/command-result-output'
import { printOrchestrationResult } from '../agent-view'
import { RuntimeClientError } from '../../runtime/connection/types'
import { ORCHESTRATION_PROGRESS_NOTE_MAX } from '../../../shared/rpc-contract/orchestration/orchestration-params'
import { readInjectedAgentSessionId } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { refuseAgentServerRoute } from '../identity/agent-server-route'
import { resolveOrchestrationTerminalHandle } from '../identity/terminal-identity'

type OrchestrationProgressResult = {
  dispatchId: string
  taskId: string
  runId: string | null
  note: string
  updatedAt: string
}

export const ORCHESTRATION_WORKER_PROGRESS_HANDLER: Record<string, CommandHandler> = {
  'orchestration progress': async (ctx) => {
    const { flags, client, cwd, json } = ctx
    await refuseAgentServerRoute('progress', ctx)
    const rawNote = await readTextOrFileFlag(flags, cwd, 'note', true)
    const note = rawNote?.trim() ?? ''
    if (!note) {
      throw new RuntimeClientError('invalid_argument', '--note cannot be empty.')
    }
    if (note.length > ORCHESTRATION_PROGRESS_NOTE_MAX) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--note must be at most ${ORCHESTRATION_PROGRESS_NOTE_MAX} characters (received ${note.length}); put longer details in your final worker_done report.`
      )
    }
    if (
      !getOptionalStringFlag(flags, 'from') &&
      !process.env.ORCA_TERMINAL_HANDLE &&
      !readInjectedAgentSessionId()
    ) {
      throw new RuntimeClientError(
        'dispatch_inactive',
        'orchestration progress requires an active worker session or --from <worker_handle>; it records passive worker status without mailing anyone. Use orca orchestration send when a recipient must be woken.'
      )
    }
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const senderPaneKey =
      from === undefined || readInjectedAgentSessionId()
        ? undefined
        : process.env.ORCA_PANE_KEY || undefined
    const dispatchCapability = getOptionalStringFlag(flags, 'dispatch-capability')
    const result = await callOrchestrationMutation<OrchestrationProgressResult>(
      client,
      flags,
      'orchestration.progress',
      {
        from,
        note,
        dispatchId: getOptionalStringFlag(flags, 'dispatch-id'),
        senderPaneKey
      },
      dispatchCapability ? { orchestrationCapability: dispatchCapability } : undefined
    )
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, {
        fields: (value) => ({
          dispatchId: value.dispatchId,
          taskId: value.taskId,
          progress: value.note,
          updatedAt: value.updatedAt
        })
      })
      return
    }
    printResult(result, json, (value) => `Recorded progress on ${value.dispatchId}: ${value.note}`)
  }
}
