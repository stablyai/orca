import {
  BACKLOG_OPERATION_TIMEOUT_MS,
  BacklogOperation,
  type BacklogReply
} from '../../shared/backlog-types'
import { assertBacklogMutationPaths, loadBacklogProject, readBacklogTasks } from './backlog-project'
import { backlogMutationUnavailable, resolveBacklogCli, runBacklogMutation } from './backlog-cli'

/** Bounds caller wait and signals CLI cancellation; a timeout does not establish whether a write completed. */
export async function executeBacklogOperation(
  repoPath: string,
  input: BacklogOperation
): Promise<BacklogReply> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>(
    /** Starts the overall deadline before project scanning or CLI execution can block the caller. */
    (_, reject) => {
      timer = setTimeout(
        /** Requests cancellation without claiming that a pending CLI write was rolled back. */
        () => {
          controller.abort()
          reject(
            new Error(
              'Backlog operation timed out. Completion is unconfirmed; refresh and inspect tasks before retrying.'
            )
          )
        },
        BACKLOG_OPERATION_TIMEOUT_MS
      )
    }
  )
  try {
    return await Promise.race([executeOperation(repoPath, input, controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Validates host-local reads and gates CLI writes on project, task-hook, and path safety checks. */
async function executeOperation(
  repoPath: string,
  input: BacklogOperation,
  signal: AbortSignal
): Promise<BacklogReply> {
  const operation = BacklogOperation.parse(input)
  const project = await loadBacklogProject(repoPath)
  const tasks = await readBacklogTasks(project)
  if (operation.kind === 'list') {
    let mutationUnavailable = backlogMutationUnavailable(project)
    if (!mutationUnavailable) {
      try {
        await resolveBacklogCli(project)
      } catch (error) {
        mutationUnavailable = error instanceof Error ? error.message : String(error)
      }
    }
    const search = operation.search.toLocaleLowerCase()
    const matching = tasks.filter(
      (task) =>
        (!operation.status || task.status === operation.status) &&
        `${task.id}\n${task.title}\n${task.body}`.toLocaleLowerCase().includes(search)
    )
    return {
      projectPath: project.root,
      projectName: project.projectName,
      statuses: project.statuses,
      tasks: matching
        .slice(operation.offset, operation.offset + 100)
        .map(({ id, title, status }) => ({ id, title, status })),
      total: matching.length,
      mutationUnavailable
    }
  }
  const task =
    operation.kind === 'create' ? null : tasks.find((candidate) => candidate.id === operation.id)
  if (operation.kind !== 'create' && !task) {
    throw new Error('Backlog task not found. Refresh the list.')
  }
  if (operation.kind === 'read' && task) {
    const { hasStatusHook: _hook, ...detail } = task
    return detail
  }
  if (operation.kind === 'read') {
    throw new Error('Backlog task not found.')
  }
  const unavailable = backlogMutationUnavailable(project)
  if (unavailable) {
    throw new Error(unavailable)
  }
  if (task?.hasStatusHook) {
    throw new Error('This task has an onStatusChange hook. Edit it with the Backlog CLI directly.')
  }
  if (
    !operation.title.trim() ||
    (!project.statuses.includes(operation.status) && operation.status !== task?.status)
  ) {
    throw new Error('A title and a configured Backlog status are required.')
  }
  await assertBacklogMutationPaths(project.backlogPath)
  signal.throwIfAborted()
  await runBacklogMutation(project, operation, task ?? null, signal)
  return { saved: true }
}
