import { runProcess } from '../../shared/child-process/run-process'
import type {
  ExternalTask,
  ExternalTaskChecklistItem,
  ExternalTaskDetail,
  ExternalTaskReference,
  ExternalTaskProvider,
  ExternalTaskProviderStatus
} from '../../shared/external-task-types'

type PlannerCliTask = {
  id?: string
  title?: string
  percentComplete?: number
  startDateTime?: string | null
  createdDateTime?: string | null
  dueDateTime?: string | null
  completedDateTime?: string | null
  planId?: string
  bucketId?: string
  priority?: number
  assignments?: Record<string, unknown>
}

type PlannerCliDetails = {
  description?: string
  checklist?: Record<string, { title?: string; isChecked?: boolean }>
  references?: Record<string, { alias?: string; previewPriority?: string; type?: string }>
}

function plannerTaskUrl(task: PlannerCliTask): string {
  if (!task.planId || !task.id) {
    return 'https://planner.cloud.microsoft/webui/'
  }
  return `https://planner.cloud.microsoft/webui/plan/${encodeURIComponent(task.planId)}/view/board/task/${encodeURIComponent(task.id)}`
}
const cwd = () =>
  process.env.ORCA_PLANNER_TOOLS_DIR ??
  'C:\\Users\\ee01287\\Documents\\Projects\\Apps\\planner-tools'
async function run(args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'uv',
    args: ['run', 'planner', ...args],
    cwd: cwd(),
    timeoutMs: 12_000
  })
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Planner CLI authentication is unavailable')
  }
  return result.stdout
}
export async function getPlannerCliStatus(
  provider: ExternalTaskProvider
): Promise<ExternalTaskProviderStatus> {
  try {
    const value = JSON.parse(await run(['whoami'])) as {
      displayName?: string
      userPrincipalName?: string
    }
    return {
      provider,
      configured: true,
      authenticated: true,
      account: value.displayName ?? value.userPrincipalName ?? null
    }
  } catch (error) {
    return {
      provider,
      configured: true,
      authenticated: false,
      account: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
export async function listPlannerCliTasks(
  query: string | undefined,
  take: number
): Promise<ExternalTask[]> {
  const tasks = JSON.parse(
    await run(['list-my-tasks', '--brief', '--open-only'])
  ) as PlannerCliTask[]
  const q = query?.trim().toLowerCase()
  return tasks
    .filter((task) => !q || task.title?.toLowerCase().includes(q))
    .slice(0, take)
    .map((task) => ({
      provider: 'planner' as const,
      id: task.id ?? '',
      identifier: task.id ?? '',
      title: task.title ?? 'Planner task',
      status: task.percentComplete === 100 ? 'Completed' : 'Open',
      assignee: null,
      updatedAt: task.dueDateTime ?? null,
      url: plannerTaskUrl(task)
    }))
}

function plannerStatus(percentComplete: number | undefined): string {
  if (percentComplete === 100) {
    return 'Completed'
  }
  if ((percentComplete ?? 0) > 0) {
    return 'In progress'
  }
  return 'Open'
}

function plannerPriorityLabel(priority: number | undefined): string | undefined {
  if (priority === undefined || priority === null) {
    return undefined
  }
  return { 1: 'Urgent', 3: 'Important', 5: 'Medium', 9: 'Low' }[priority] ?? String(priority)
}

function plannerChecklist(
  checklist: PlannerCliDetails['checklist']
): ExternalTaskChecklistItem[] {
  return Object.entries(checklist ?? {}).map(([itemId, item]) => ({
    id: itemId,
    title: item.title ?? itemId,
    completed: Boolean(item.isChecked)
  }))
}

function plannerReferences(
  references: PlannerCliDetails['references']
): ExternalTaskReference[] {
  return Object.entries(references ?? {}).map(([url, reference]) => ({
    id: url,
    title: reference.alias ?? reference.type ?? 'Reference',
    url,
    subtitle: reference.previewPriority ?? undefined
  }))
}

export async function getPlannerCliTask(id: string): Promise<ExternalTaskDetail> {
  const [task, details] = await Promise.all([
    run(['get', '--task', id]).then((value) => JSON.parse(value) as PlannerCliTask),
    run(['details', '--task', id]).then((value) => JSON.parse(value) as PlannerCliDetails)
  ])
  return {
    provider: 'planner',
    id: task.id ?? id,
    identifier: task.id ?? id,
    title: task.title ?? 'Planner task',
    status: plannerStatus(task.percentComplete),
    assignee: null,
    updatedAt: task.dueDateTime ?? null,
    url: plannerTaskUrl(task),
    description: details.description,
    createdAt: task.createdDateTime ?? null,
    dueAt: task.dueDateTime ?? null,
    completedAt: task.completedDateTime ?? null,
    priority: plannerPriorityLabel(task.priority),
    checklist: plannerChecklist(details.checklist),
    references: plannerReferences(details.references),
    detailSections: [
      {
        id: 'schedule',
        title: 'Schedule',
        fields: [
          { label: 'Status', value: plannerStatus(task.percentComplete) },
          { label: 'Priority', value: plannerPriorityLabel(task.priority) ?? null },
          { label: 'Start', value: task.startDateTime ?? null },
          { label: 'Due', value: task.dueDateTime ?? null },
          { label: 'Completed', value: task.completedDateTime ?? null }
        ].filter((field) => field.value)
      },
      {
        id: 'planner',
        title: 'Planner',
        fields: [
          { label: 'Plan', value: task.planId ?? null },
          { label: 'Bucket', value: task.bucketId ?? null },
          {
            label: 'Assignments',
            value: task.assignments ? String(Object.keys(task.assignments).length) : null
          }
        ].filter((field) => field.value)
      }
    ]
  }
}

export async function updatePlannerCliTask(args: {
  id: string
  title?: string
  status?: string
  description?: string
}): Promise<void> {
  const updateArgs = ['update', '--task', args.id]
  if (args.title !== undefined) {
    updateArgs.push('--title', args.title)
  }
  if (args.status !== undefined) {
    const normalized = args.status.trim().toLowerCase()
    const percent = normalized === 'completed' || normalized === 'done' ? '100' : normalized.includes('progress') ? '50' : '0'
    updateArgs.push('--percent', percent)
  }
  if (updateArgs.length > 3) {
    await run(updateArgs)
  }
  if (args.description !== undefined) {
    await run(['describe', args.description, '--task', args.id])
  }
}
