import { createHash, randomUUID } from 'node:crypto'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../arguments/flags'
import type { HandlerContext } from '../../dispatch/dispatch'
import { parseCliAgent } from '../../agents/agent-launch-request'
import { RuntimeClientError } from '../../runtime/connection/types'
import { readRetryRequestFlag } from '../recovery/retry-request-flag'
import { openDispatchMemory } from './dispatch-memory'
import { planCommanderDispatch } from './model-routing'

export async function prepareCommanderDispatch(
  { flags, client }: HandlerContext,
  args: { spec?: string; task?: string; from?: string; model?: string; effort?: string },
  host: string | undefined
) {
  if (!flags.has('commander-project')) {
    if (flags.has('commander-task-kind')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--commander-task-kind requires --commander-project.'
      )
    }
    return undefined
  }
  const projectId = getRequiredStringFlag(flags, 'commander-project')
  const agent = parseCliAgent(getRequiredStringFlag(flags, 'agent'))
  if (flags.has('terminal') || Boolean(args.task) === Boolean(args.spec)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Commander routing needs a fresh agent and exactly one task or spec.'
    )
  }
  const memory = await openDispatchMemory(projectId)
  const taskKind = getOptionalStringFlag(flags, 'commander-task-kind')
  const normalizedLaunch = JSON.stringify(args, Object.keys(args).sort())
  const binding = createHash('sha256')
    .update(JSON.stringify([projectId, host, taskKind, flags.has('keep-open'), normalizedLaunch]))
    .digest('hex')
  const retry = readRetryRequestFlag(flags)
  if (retry) {
    return memory.replay(retry, binding)
  }
  const pages = await memory.list()
  const run = getOptionalStringFlag(flags, 'run')
  let taskSpec = args.spec
  if (args.task) {
    const { result } = await client.call<{ tasks: { id: string; spec: string }[] }>(
      'orchestration.taskList',
      { run, callerTerminalHandle: args.from }
    )
    taskSpec = result.tasks.find((task) => task.id === args.task)?.spec
    if (!taskSpec) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Could not read the selected Commander task.'
      )
    }
  }
  const placement = getOptionalStringFlag(flags, 'worktree')
  const plan = planCommanderDispatch({
    ...args,
    pages,
    projectId,
    agent,
    spec: taskSpec ?? '',
    taskKind,
    createsWorktree: placement === 'new-child' || placement === 'new-top-level'
  })
  const requestId = randomUUID()
  const pageId = `dispatch-${requestId}`
  const { guidelines, ...decision } = plan
  const page = await memory.write(
    {
      pageId,
      projectId,
      requestId,
      expectedVersion: 0,
      kind: 'decision',
      title: `Planned ${agent} dispatch · ${decision.taskKind ?? 'general task'}`,
      body: [
        'Planned worker launch. Check the matching Orca dispatch receipt for the actual outcome.',
        '',
        `- Task — ${args.task ?? taskSpec?.split('\n')[0].slice(0, 160)}`,
        ...(run ? [`- Run — ${run}`] : []),
        `- Agent — ${agent}`,
        `- Requested model — ${decision.model ?? 'agent default'}`,
        `- Requested effort — ${decision.effort ?? 'agent default'}`,
        `- Reason — ${decision.reason}`,
        ...decision.sources.map((s) => `- Source — ${s.pageId} (revision ${s.version})`)
      ].join('\n'),
      links: decision.sources.map((s) => s.pageId)
    },
    { binding, model: plan.model, effort: plan.effort, reason: plan.reason, guidelines }
  )
  return { ...decision, guidelines, requestId, pageId: page.pageId, projectId }
}
