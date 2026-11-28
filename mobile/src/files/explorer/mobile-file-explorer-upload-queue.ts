import { useSyncExternalStore } from 'react'
import {
  MobilePickedFileGoneError,
  type StagedMobileFile
} from '../../platform/media-picking/media-picker-contract'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ExplorerTarget } from './mobile-file-explorer-mutations'
import { runUpload } from './mobile-file-explorer-upload-run'
import { watchClientsForReconnect } from './mobile-file-explorer-upload-client-watch'
import { forgetProgress, setProgress } from './mobile-file-explorer-upload-progress'

/** `offline`: waits for the host to come back, then starts that file again (the host dropped what it had). */
/** `unconfirmed`: the commit got no answer, so the row asks the user to check rather than retry. */
export type UploadStatus = 'waiting' | 'offline' | 'uploading' | 'clash' | 'failed' | 'unconfirmed'

export type UploadRow = {
  readonly id: string
  readonly parent: string
  readonly name: string
  readonly byteLength: number
  readonly status: UploadStatus
  readonly error?: string
  /** For a clash: the free name Keep Both would use. */
  readonly copyName?: string
  /** For a clash: its sheet was closed without a choice, so it waits for its row to be tapped. */
  readonly promptClosed?: boolean
  readonly batch: string
}

type Job = UploadRow & {
  scope: string
  client: RpcClient
  target: ExplorerTarget
  file: StagedMobileFile
  keepBoth: boolean
  /** Transport cuts (a path switch, a socket the host forgot) start the file over a few times. */
  restarts: number
}

type Batch = {
  uploaded: number
  lost: number
  /** Keep Both or Skip chosen for every clash of the pick, including ones still to come. */
  clashChoice?: 'keepBoth' | 'skip'
  /** The folder's listing is out of date: a file landed, or may have. */
  refreshFolder: () => void
  onDone: (result: { uploaded: number; lost: number; folder: string }) => void
}

const MAX_RESTARTS = 3
// Well inside the shell's five idle minutes per picked file.
const KEEP_ALIVE_MS = 2 * 60_000
const NO_ROWS: readonly UploadRow[] = []

// Page-wide, so closing and reopening Files keeps the queue and its progress.
let jobs: readonly Job[] = []
const batches = new Map<string, Batch>()
const listeners = new Set<() => void>()
const rowsByScope = new Map<string, readonly UploadRow[]>()
// Only scopes with jobs: what the route says about reaching the workspace's host.
const unreachable = new Set<string>()
let keepAlive: ReturnType<typeof setInterval> | null = null
let running = false
let nextId = 0

function publish(next: readonly Job[]): void {
  jobs = next
  // Per-scope state lives only as long as the scope has jobs.
  for (const scope of [...rowsByScope.keys(), ...unreachable]) {
    if (!jobs.some((job) => job.scope === scope)) {
      rowsByScope.delete(scope)
      unreachable.delete(scope)
    }
  }
  watchClientsForReconnect(
    new Set(jobs.filter((job) => job.status === 'offline').map((job) => job.client)),
    (client) => resume((job) => job.client === client && !unreachable.has(job.scope))
  )
  // Only while a transfer runs and others wait behind it: a stalled queue lets its files lapse after
  // the shell's five minutes, so the page's few picked-file slots free up for chat attachments.
  const behind =
    jobs.some((job) => job.status === 'uploading') && jobs.some((job) => job.status === 'waiting')
  if (behind && !keepAlive) {
    keepAlive = setInterval(() => void keepQueuedFilesAlive(), KEEP_ALIVE_MS)
  } else if (!behind && keepAlive) {
    clearInterval(keepAlive)
    keepAlive = null
  }
  for (const listener of listeners) {
    listener()
  }
}

function resume(which: (job: Job) => boolean): void {
  if (jobs.some((job) => job.status === 'offline' && which(job))) {
    publish(
      jobs.map((job) =>
        job.status === 'offline' && which(job) ? { ...job, status: 'waiting', restarts: 0 } : job
      )
    )
    void pump()
  }
}

function update(id: string, patch: Partial<Job>): void {
  if (jobs.some((job) => job.id === id)) {
    publish(jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)))
  }
}

function remove(id: string, outcome: 'uploaded' | 'lost' | 'dropped'): void {
  const job = jobs.find((candidate) => candidate.id === id)
  if (!job) {
    return
  }
  publish(jobs.filter((candidate) => candidate.id !== id))
  forgetProgress(id)
  void job.file.release()
  const batch = batches.get(job.batch)
  if (!batch) {
    return
  }
  if (outcome !== 'dropped') {
    batch[outcome] += 1
  }
  if (!jobs.some((candidate) => candidate.batch === job.batch)) {
    batches.delete(job.batch)
    if (batch.uploaded + batch.lost > 0) {
      batch.onDone({ uploaded: batch.uploaded, lost: batch.lost, folder: job.parent })
    }
  }
}

// A file the shell already let go of can't come back: it leaves the queue and its batch reports it.
async function keepQueuedFilesAlive(): Promise<void> {
  for (const job of jobs.filter((candidate) => candidate.status === 'waiting')) {
    try {
      await job.file.keepAlive()
    } catch (error) {
      if (error instanceof MobilePickedFileGoneError) {
        remove(job.id, 'lost')
      }
    }
  }
}

export function enqueueUploads(args: {
  scope: string
  client: RpcClient
  target: ExplorerTarget
  parent: string
  files: readonly StagedMobileFile[]
  refreshFolder: Batch['refreshFolder']
  onDone: Batch['onDone']
}): void {
  if (args.files.length === 0) {
    return
  }
  const batch = `batch-${(nextId += 1)}`
  batches.set(batch, {
    uploaded: 0,
    lost: 0,
    refreshFolder: args.refreshFolder,
    onDone: args.onDone
  })
  publish([
    ...jobs,
    ...args.files.map((file): Job => ({
      id: `upload-${(nextId += 1)}`,
      batch,
      scope: args.scope,
      client: args.client,
      target: args.target,
      file,
      parent: args.parent,
      name: file.name,
      byteLength: file.byteLength,
      status: 'waiting',
      keepBoth: false,
      restarts: 0
    }))
  ])
  void pump()
}

/** The route's word on reaching the workspace's host: a relayed server can drop while the paired computer stays up. */
export function noteUploadHostReachable(scope: string, reachable: boolean): void {
  if (!jobs.some((job) => job.scope === scope)) {
    return
  }
  if (!reachable) {
    unreachable.add(scope)
    return
  }
  unreachable.delete(scope)
  resume((job) => job.scope === scope)
}

/** Keep Both or Skip for one clash, or for every clash of its pick. */
export function resolveClash(id: string, choice: 'keepBoth' | 'skip', applyToAll: boolean): void {
  const clash = jobs.find((job) => job.id === id)
  const batch = clash && batches.get(clash.batch)
  if (applyToAll && batch) {
    batch.clashChoice = choice
  }
  const chosen = jobs.filter(
    (job) => job.status === 'clash' && (job.id === id || (applyToAll && job.batch === clash?.batch))
  )
  for (const job of chosen) {
    if (choice === 'skip') {
      remove(job.id, 'dropped')
    } else {
      update(job.id, { status: 'waiting', keepBoth: true })
    }
  }
  void pump()
}

export function setClashPromptClosed(ids: readonly string[], closed: boolean): void {
  if (jobs.some((job) => ids.includes(job.id) && job.promptClosed !== closed)) {
    publish(jobs.map((job) => (ids.includes(job.id) ? { ...job, promptClosed: closed } : job)))
  }
}

// A retry starts from the plain name: a copy that may have landed then shows as a clash to choose again.
export function retryUpload(id: string): void {
  update(id, { status: 'waiting', error: undefined, restarts: 0, keepBoth: false })
  void pump()
}

/** Leaves the folder as it is and frees the phone's copy. */
export function dismissUpload(id: string): void {
  if (jobs.find((job) => job.id === id)?.status !== 'uploading') {
    remove(id, 'dropped')
  }
}

function reachable(job: Job): boolean {
  return !unreachable.has(job.scope) && job.client.getState() === 'connected'
}

async function pump(): Promise<void> {
  if (running) {
    return
  }
  running = true
  try {
    for (;;) {
      const job = jobs.find((candidate) => candidate.status === 'waiting')
      if (!job) {
        return
      }
      if (!reachable(job)) {
        update(job.id, { status: 'offline' })
        continue
      }
      await run(job)
    }
  } finally {
    running = false
  }
}

async function run(job: Job): Promise<void> {
  update(job.id, { status: 'uploading' })
  setProgress(job.id, 0)
  const verdict = await runUpload(job, (sent) => setProgress(job.id, sent))
  switch (verdict.kind) {
    case 'uploaded':
      batches.get(job.batch)?.refreshFolder()
      remove(job.id, 'uploaded')
      return
    case 'lost':
      remove(job.id, 'lost')
      return
    case 'unconfirmed':
      batches.get(job.batch)?.refreshFolder()
      update(job.id, { status: 'unconfirmed', error: verdict.message })
      return
    case 'clash': {
      const choice = batches.get(job.batch)?.clashChoice
      update(job.id, { status: 'clash', copyName: verdict.copyName, promptClosed: false })
      if (choice) {
        resolveClash(job.id, choice, false)
      }
      return
    }
    case 'cut':
      if (!reachable(job)) {
        update(job.id, { status: 'offline' })
      } else if (verdict.transport && job.restarts < MAX_RESTARTS) {
        update(job.id, { status: 'waiting', restarts: job.restarts + 1 })
      } else {
        update(job.id, { status: 'failed', error: verdict.message })
      }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// A scope keeps its snapshot while its own jobs are unchanged, so one workspace's upload doesn't repaint
// another's Files; empty scopes aren't kept.
function rowsFor(scope: string): readonly UploadRow[] {
  const mine = jobs.filter((job) => job.scope === scope)
  const cached = rowsByScope.get(scope)
  if (mine.length === 0) {
    rowsByScope.delete(scope)
    return NO_ROWS
  }
  if (cached?.length === mine.length && cached.every((row, index) => row === mine[index])) {
    return cached
  }
  rowsByScope.set(scope, mine)
  return mine
}

/** This workspace's uploads that haven't landed yet, in the order they were picked. */
export function useUploadRows(scope: string): readonly UploadRow[] {
  return useSyncExternalStore(
    subscribe,
    () => rowsFor(scope),
    () => NO_ROWS
  )
}
