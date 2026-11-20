import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type {
  LocalTask,
  LocalTaskListResult,
  LocalTaskStatusCategory
} from '../../shared/local-tasks/local-task-types'
import {
  parseLocalTaskFile,
  parseLocalTaskList,
  parseLocalTaskPriority
} from './local-task-frontmatter'

// Neutral per-user default; point it elsewhere with ORCA_LOCAL_TASKS_DIR or a symlink.
const DEFAULT_FOLDER = join(homedir(), '.orca', 'tasks')

// Handoff-style statuses first; common issue-tracker names as fallback.
const STATUS_CATEGORY: Record<string, LocalTaskStatusCategory> = {
  queued: 'todo',
  todo: 'todo',
  working: 'in-progress',
  'in-progress': 'in-progress',
  'in progress': 'in-progress',
  blocked: 'blocked',
  done: 'done',
  dropped: 'done',
  completed: 'done'
}

export const LOCAL_TASK_STATUSES = Object.keys(STATUS_CATEGORY)

export function getLocalTasksFolder(): string {
  return process.env.ORCA_LOCAL_TASKS_DIR?.trim() || DEFAULT_FOLDER
}

export function categorizeLocalTaskStatus(status: string): LocalTaskStatusCategory {
  return STATUS_CATEGORY[status.trim().toLowerCase()] ?? 'todo'
}

export async function listLocalTasks(): Promise<LocalTaskListResult> {
  const folder = getLocalTasksFolder()
  let names: string[]
  try {
    names = await readdir(folder)
  } catch (error) {
    // A missing folder is an empty backlog, not a failure.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { folder, tasks: [] }
    }
    throw error
  }
  const tasks = await Promise.all(
    names.filter((name) => extname(name) === '.md').map((name) => readLocalTask(join(folder, name)))
  )
  return { folder, tasks: tasks.filter((task): task is LocalTask => task !== null) }
}

export async function readLocalTask(filePath: string): Promise<LocalTask | null> {
  try {
    const [text, info] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
    const { fields, body } = parseLocalTaskFile(text)
    const id = basename(filePath, '.md')
    const status = fields.status ?? 'todo'
    return {
      id,
      title: fields.title || firstHeadingOrLine(body) || id,
      status,
      statusCategory: categorizeLocalTaskStatus(status),
      labels: parseLocalTaskList(fields.labels),
      url: fields.url || fields.source || null,
      dependsOn: parseLocalTaskList(fields.depends_on),
      priority: parseLocalTaskPriority(fields.priority),
      claimedBy: fields.claimed_by || null,
      claimedAt: fields.claimed_at || null,
      blockedReason: fields.blocked_reason || null,
      updatedAt: fields.updated || info.mtime.toISOString(),
      filePath,
      fields
    }
  } catch {
    // One unreadable file must not hide the rest of the backlog.
    return null
  }
}

function firstHeadingOrLine(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  return line.replace(/^#+\s*/, '').trim()
}
