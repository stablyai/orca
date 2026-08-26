import type {
  LinearIssueTaskUpdateRequest,
  LinearIssueTaskUpdateResult,
  LinearTeamCyclesResult
} from '../../shared/linear/agent-access'
import { LINEAR_ISSUE_CYCLE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { formatLinearTaskUpdate, formatLinearTeamCycles } from '../linear-format'
import { buildWriteTargetRequest } from '../linear-request-builders'
import { RuntimeClientError } from '../runtime-client'

const LINEAR_WRITE_TIMEOUT_MS = 75_000

export const LINEAR_CYCLE_COMMANDS: Record<string, CommandHandler> = {
  'linear team cycles': async ({ flags, client, json }) => {
    await assertCycleSupported(client)
    const response = await client.call<LinearTeamCyclesResult>('linear.agentTeamCycles', {
      teamInput: getRequiredStringFlag(flags, 'team'),
      workspaceId: getOptionalStringFlag(flags, 'workspace'),
      currentOnly: flags.get('current') === true
    })
    printResult(response, json, formatLinearTeamCycles)
  },
  'linear cycle set': async (ctx) =>
    runCycleUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'cycle',
      cycleInput: getRequiredStringFlag(ctx.flags, 'to')
    }),
  'linear cycle clear': async (ctx) =>
    runCycleUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'cycle',
      cycleInput: null
    })
}

async function runCycleUpdate(
  { client, json }: Parameters<CommandHandler>[0],
  request: LinearIssueTaskUpdateRequest
): Promise<void> {
  await assertCycleSupported(client)
  const response = await client.call<LinearIssueTaskUpdateResult>(
    'linear.issueUpdateTask',
    request,
    { timeoutMs: LINEAR_WRITE_TIMEOUT_MS }
  )
  printResult(response, json, formatLinearTaskUpdate)
}

async function assertCycleSupported(
  client: Parameters<CommandHandler>[0]['client']
): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(LINEAR_ISSUE_CYCLE_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime is too old for Linear cycle management. Update or restart Orca and try again.'
    )
  }
}
