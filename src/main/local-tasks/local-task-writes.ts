import { link, mkdir, readFile, rename, stat, unlink, writeFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { computeLocalTaskReadiness } from '../../shared/local-tasks/local-task-scheduling'
import type { LocalTask } from '../../shared/local-tasks/local-task-types'
import {
  LOCAL_TASK_STATUSES,
  categorizeLocalTaskStatus,
  getLocalTasksFolder,
  listLocalTasks,
  readLocalTask
} from './local-task-store'

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/d
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000

export type LocalTaskPatch = {
  title?: string
  status?: string
  labels?: string[]
  priority?: number
  dependsOn?: string[]
  blockedReason?: string | null
  url?: string | null
}

export type CreateLocalTaskInput = LocalTaskPatch & { title: string; id?: string; body?: string }

function assertId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid task id: ${JSON.stringify(id)}`)
  }
}

function assertLine(value: string, what: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${what} must be a single line`)
  }
  return value.trim()
}

function assertStatus(status: string): string {
  const clean = assertLine(status, 'status').toLowerCase()
  if (!LOCAL_TASK_STATUSES.includes(clean)) {
    throw new Error(
      `Unknown status ${JSON.stringify(status)}; expected one of ${LOCAL_TASK_STATUSES.join(', ')}`
    )
  }
  return clean
}

// Scalars are written bare; the reader strips ` # comment` and matching quotes, so quote when needed.
function formatScalar(value: string, what: string): string {
  const clean = assertLine(value, what)
  if (/^(['"]).*\1$/.test(clean) || /\s#/.test(clean) || clean.startsWith('#')) {
    if (clean.includes('"')) {
      throw new Error(`${what} cannot contain quotes together with comment markers`)
    }
    return `"${clean}"`
  }
  return clean
}

// Maps a patch to frontmatter key -> value, validating everything before any file is touched.
function patchToFields(patch: LocalTaskPatch): Record<string, string> {
  const out: Record<string, string> = {}
  if (patch.title !== undefined) {
    out.title = formatScalar(patch.title, 'title')
    if (!out.title) {
      throw new Error('title must not be empty')
    }
  }
  if (patch.status !== undefined) {
    out.status = assertStatus(patch.status)
  }
  if (patch.labels !== undefined) {
    const labels = patch.labels.map((l) => assertLine(l, 'label'))
    if (labels.some((l) => !l || l.includes(',') || /[[\]]/.test(l))) {
      throw new Error('labels must be non-empty and contain no commas or brackets')
    }
    out.labels = `[${labels.join(', ')}]`
  }
  if (patch.priority !== undefined) {
    if (!Number.isInteger(patch.priority) || patch.priority < 1 || patch.priority > 5) {
      throw new Error('priority must be an integer from 1 to 5')
    }
    out.priority = String(patch.priority)
  }
  if (patch.dependsOn !== undefined) {
    patch.dependsOn.forEach(assertId)
    out.depends_on = `[${patch.dependsOn.join(', ')}]`
  }
  if (patch.blockedReason !== undefined) {
    out.blocked_reason =
      patch.blockedReason === null ? '' : formatScalar(patch.blockedReason, 'blockedReason')
  }
  if (patch.url !== undefined) {
    out.url = patch.url === null ? '' : formatScalar(patch.url, 'url')
  }
  return out
}

const today = (): string => new Date().toISOString().slice(0, 10)

/** Replaces or appends only the given keys inside the frontmatter block; every other byte is kept. */
export function applyFrontmatterEdits(text: string, edits: Record<string, string>): string {
  const render = (key: string, value: string): string => (value ? `${key}: ${value}` : `${key}:`)
  const match = FRONTMATTER.exec(text)
  const span = match?.indices?.[1]
  if (!span) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = Object.entries(edits).map(([k, v]) => render(k, v))
    return `---${eol}${lines.join(eol)}${eol}---${eol}${text}`
  }
  const [start, end] = span
  const eol = text.slice(start, end).includes('\r\n') || text[start - 2] === '\r' ? '\r\n' : '\n'
  const lines = text.slice(start, end).split('\n')
  const pending = new Map(Object.entries(edits))
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const colon = line.indexOf(':')
    if (colon <= 0 || /^\s/.test(line)) {
      continue
    }
    const key = line.slice(0, colon).trim()
    const value = pending.get(key)
    if (value !== undefined) {
      lines[i] = render(key, value) + (line.endsWith('\r') ? '\r' : '')
      pending.delete(key)
    }
  }
  const added = [...pending].map(([k, v]) => render(k, v))
  const block = lines.join('\n') + added.map((l) => eol + l).join('')
  return text.slice(0, start) + block + text.slice(end)
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = join(getLocalTasksFolder(), `.${randomUUID()}.tmp`)
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, filePath)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

const taskPath = (id: string): string => join(getLocalTasksFolder(), `${id}.md`)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Per-task mutex: an exclusive-create (`wx`) lock file next to the task. open(O_EXCL) is atomic on local
// filesystems, so exactly one caller holds it; read-modify-write (and thus claim) runs inside it.
// ponytail: stale-lock cleanup (30s) can race two waiters; use a PID/lease check if crashes mid-write matter.
async function withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(getLocalTasksFolder(), `.${id}.lock`)
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await (await open(lockPath, 'wx')).close()
      break
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
      const age = await stat(lockPath).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0
      )
      if (age > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => {})
      } else if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock on task ${id}`)
      } else {
        await sleep(5 + Math.random() * 15)
      }
    }
  }
  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => {})
  }
}

async function editTask(id: string, edits: Record<string, string>): Promise<void> {
  const filePath = taskPath(id)
  const text = await readFile(filePath, 'utf8').catch(() => {
    throw new Error(`Task not found: ${id}`)
  })
  await atomicWrite(filePath, applyFrontmatterEdits(text, { ...edits, updated: today() }))
}

async function mustRead(id: string): Promise<LocalTask> {
  const task = await readLocalTask(taskPath(id))
  if (!task) {
    throw new Error(`Task not found: ${id}`)
  }
  return task
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || `task-${Date.now()}`
}

export async function createLocalTask(input: CreateLocalTaskInput): Promise<LocalTask> {
  const id = input.id ?? slugify(input.title)
  assertId(id)
  const fields = patchToFields({ ...input, status: input.status ?? 'todo' })
  const date = today()
  const head = applyFrontmatterEdits('', { ...fields, created: date, updated: date })
  const body = input.body ?? ''
  const withBody = body && !body.endsWith('\n') ? `${head}${body}\n` : head + body
  await mkdir(getLocalTasksFolder(), { recursive: true })
  // Exclusive create: write a temp file, then hard-link it to the final name (EEXIST if taken), so a
  // reader never sees a half-written file and an existing task is never overwritten.
  const tmp = join(getLocalTasksFolder(), `.${randomUUID()}.tmp`)
  await writeFile(tmp, withBody, 'utf8')
  try {
    await link(tmp, taskPath(id))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Task already exists: ${id}`)
    }
    throw error
  } finally {
    await unlink(tmp).catch(() => {})
  }
  return mustRead(id)
}

export async function updateLocalTask(id: string, patch: LocalTaskPatch): Promise<LocalTask> {
  assertId(id)
  const fields = patchToFields(patch)
  await withTaskLock(id, async () => {
    // A task leaving 'blocked' should not keep a stale reason (unless the caller sets one).
    if (fields.status !== undefined && fields.blocked_reason === undefined) {
      const current = await mustRead(id)
      if (current.blockedReason && categorizeLocalTaskStatus(fields.status) !== 'blocked') {
        fields.blocked_reason = ''
      }
    }
    await editTask(id, fields)
  })
  return mustRead(id)
}

function assertClaimer(claimer: string): string {
  const clean = assertLine(claimer, 'claimer')
  if (!clean) {
    throw new Error('claimer must not be empty')
  }
  return clean
}

export async function claimLocalTask(id: string, claimer: string): Promise<LocalTask> {
  assertId(id)
  const by = assertClaimer(claimer)
  await withTaskLock(id, async () => {
    const { tasks } = await listLocalTasks()
    const state = computeLocalTaskReadiness(tasks).find((r) => r.id === id)
    if (!state) {
      throw new Error(`Task not found: ${id}`)
    }
    if (state.state !== 'ready') {
      throw new Error(`Task ${id} is not claimable (${state.state})`)
    }
    await editTask(id, {
      claimed_by: formatScalar(by, 'claimer'),
      claimed_at: new Date().toISOString(),
      status: 'working'
    })
  })
  return mustRead(id)
}

export async function releaseLocalTask(id: string, claimer: string): Promise<LocalTask> {
  assertId(id)
  const by = assertClaimer(claimer)
  await withTaskLock(id, async () => {
    const task = await mustRead(id)
    if (task.claimedBy !== by) {
      throw new Error(`Task ${id} is not claimed by ${by}`)
    }
    await editTask(id, { claimed_by: '', claimed_at: '', status: 'queued' })
  })
  return mustRead(id)
}
