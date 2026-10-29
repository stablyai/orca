import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes
} from '../../shared/agent-launch/startup/agent-prompt-injection'
import type { RuntimePtyController } from '../runtime/runtime-pty-controller-contract'
import {
  buildClaudeSessionMoveHandoffNote,
  claudeResumeHookBaseline,
  claudeResumeHooksReady,
  claudeResumeScreenAcceptsHandoff,
  claudeResumeScreenIsShellPrompt,
  detachedJobsForSession,
  type ClaudeSessionDetachedJob,
  type ClaudeSessionMoveEndedWork,
  type ClaudeSessionMoveHandoffTranslate
} from './claude-session-move-handoff-note'

export const CLAUDE_SESSION_MOVE_HANDOFF_TIMEOUT_MS = 30_000
export const CLAUDE_SESSION_MOVE_HANDOFF_POLL_MS = 250

export type ClaudeSessionMoveHandoff = {
  fromEmail: string
  toEmail: string
  detail: string
  endedWork: ClaudeSessionMoveEndedWork
}

type HandoffHooks = {
  getStatusSnapshotForPane: (paneKey: string) => readonly {
    state: string
    receivedAt: number
    providerSession?: { id: string }
    providerSessionOnly?: boolean
  }[]
  getProviderSessionIdentities: () => readonly { paneKey: string; sessionId: string }[]
}

type HandoffController = Pick<RuntimePtyController, 'write'> &
  Partial<Pick<RuntimePtyController, 'serializeBuffer'>>

export async function deliverClaudeSessionMoveHandoff(args: {
  controller: HandoffController
  hooks: HandoffHooks
  ptyId: string
  paneKey: string
  sessionId: string
  /** Highest `receivedAt` on the pane before `claude --resume` was spawned. */
  baselineReceivedAt?: number
  handoff: ClaudeSessionMoveHandoff
  translate: ClaudeSessionMoveHandoffTranslate
  /** Job directory. The default is the host durable-job root. */
  jobRoot?: string
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<'sent' | 'unsent'> {
  const timeoutMs = args.timeoutMs ?? CLAUDE_SESSION_MOVE_HANDOFF_TIMEOUT_MS
  const sleep = args.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const polls = Math.max(1, Math.ceil(timeoutMs / CLAUDE_SESSION_MOVE_HANDOFF_POLL_MS))
  const baseline =
    args.baselineReceivedAt ??
    claudeResumeHookBaseline(args.hooks.getStatusSnapshotForPane(args.paneKey))
  let readyByHooks = false
  for (let poll = 0; poll < polls; poll += 1) {
    if (hooksReady(args.hooks, args.paneKey, args.sessionId, baseline)) {
      readyByHooks = true
      break
    }
    await sleep(CLAUDE_SESSION_MOVE_HANDOFF_POLL_MS)
  }
  if (!readyByHooks && hooksReady(args.hooks, args.paneKey, args.sessionId, baseline)) {
    readyByHooks = true
  }
  const screen = await readScreen(args.controller, args.ptyId)
  if (screen !== null && claudeResumeScreenIsShellPrompt(screen)) {
    return 'unsent'
  }
  if (!readyByHooks && (screen === null || !claudeResumeScreenAcceptsHandoff(screen))) {
    return 'unsent'
  }
  const listed = await listDetachedJobs(args.jobRoot)
  const jobs = Array.isArray(listed) ? listed.filter(isDetachedJob) : []
  const note = buildClaudeSessionMoveHandoffNote(
    {
      ...args.handoff,
      detachedJobs: detachedJobsForSession(args.sessionId, jobs)
    },
    args.translate
  )
  const wrote = args.controller.write(
    args.ptyId,
    `${buildAgentPromptPasteBytes(note)}${AGENT_PROMPT_SUBMIT}`,
    'orchestration'
  )
  return wrote ? 'sent' : 'unsent'
}

const DURABLE_JOB_SCRIPT = fileURLToPath(
  new URL('../../../resources/durable-jobs/durable-background-job.mjs', import.meta.url)
)
const DURABLE_JOB_ID = /^dj_[a-f0-9]{16}$/

/** The job script is optional. This note still compiles and lists jobs when that file is absent. */
async function listDetachedJobs(root: string | undefined): Promise<unknown> {
  const fromScript = await listJobsFromScript(root)
  if (fromScript) {
    return fromScript
  }
  return root ? listJobsFromDisk(root) : []
}

async function listJobsFromScript(root: string | undefined): Promise<unknown[] | null> {
  if (!existsSync(DURABLE_JOB_SCRIPT)) {
    return null
  }
  try {
    const specifier = pathToFileURL(DURABLE_JOB_SCRIPT).href
    const imported: unknown = await import(specifier)
    if (typeof imported !== 'object' || imported === null || !('listJobs' in imported)) {
      return null
    }
    const listJobs = imported.listJobs
    if (typeof listJobs !== 'function') {
      return null
    }
    // listJobs is the durable-job script export; the caller re-checks each row.
    const listed: unknown = Reflect.apply(listJobs, undefined, [root])
    return Array.isArray(listed) ? listed : null
  } catch {
    return null
  }
}

function listJobsFromDisk(root: string): ClaudeSessionDetachedJob[] {
  if (!existsSync(root)) {
    return []
  }
  const jobs: ClaudeSessionDetachedJob[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !DURABLE_JOB_ID.test(entry.name)) {
      continue
    }
    const job = readDetachedJob(root, entry.name)
    if (job) {
      jobs.push(job)
    }
  }
  return jobs.sort((left, right) => left.id.localeCompare(right.id))
}

function readDetachedJob(root: string, id: string): ClaudeSessionDetachedJob | null {
  const dir = join(root, id)
  const request = readJsonRecord(join(dir, 'request.json'))
  if (!request || typeof request.command !== 'string') {
    return null
  }
  const meta = readJsonRecord(join(dir, 'meta.json'))
  const exitCode = readExitCode(join(dir, 'exit'))
  const pid = typeof meta?.pid === 'number' ? meta.pid : undefined
  let state = 'pending'
  if (exitCode !== undefined) {
    state = 'exited'
  } else if (pid !== undefined && pidAlive(pid)) {
    state = 'running'
  } else if (pid !== undefined) {
    state = 'lost'
  }
  return {
    id,
    state,
    logPath: join(dir, 'output.log'),
    ...(typeof request.sessionId === 'string' ? { sessionId: request.sessionId } : {})
  }
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined
    }
    const record: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      record[key] = entry
    }
    return record
  } catch {
    return undefined
  }
}

function readExitCode(path: string): number | undefined {
  try {
    const code = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(code) ? code : undefined
  } catch {
    return undefined
  }
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isDetachedJob(value: unknown): value is ClaudeSessionDetachedJob {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('id' in value) || typeof value.id !== 'string') {
    return false
  }
  if (!('state' in value) || typeof value.state !== 'string') {
    return false
  }
  if (!('logPath' in value) || typeof value.logPath !== 'string') {
    return false
  }
  return (
    !('sessionId' in value) || value.sessionId === undefined || typeof value.sessionId === 'string'
  )
}

function hooksReady(
  hooks: HandoffHooks,
  paneKey: string,
  sessionId: string,
  baselineReceivedAt: number
): boolean {
  return claudeResumeHooksReady({
    rows: hooks.getStatusSnapshotForPane(paneKey),
    identities: hooks.getProviderSessionIdentities(),
    paneKey,
    sessionId,
    baselineReceivedAt
  })
}

async function readScreen(controller: HandoffController, ptyId: string): Promise<string | null> {
  if (!controller.serializeBuffer) {
    return null
  }
  try {
    const snapshot = await controller.serializeBuffer(ptyId, { scrollbackRows: 0 })
    return snapshot?.data ?? null
  } catch {
    return null
  }
}
