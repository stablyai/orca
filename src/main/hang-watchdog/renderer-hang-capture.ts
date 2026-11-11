import { app, webContents, type BrowserWindow, type WebFrameMain } from 'electron'
import { resolveObservabilityConsent } from '../observability'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import {
  emptyHangStacks,
  hangLabel,
  hangModule,
  topHangStacks,
  type HangStack
} from './hang-stacks'
import { publishRendererHang, type RendererHangRecord } from './renderer-hang-records'

type Episode = {
  record: RendererHangRecord
  deadline: number
  attempts: number
  candidates: HangStack[]
  timer?: ReturnType<typeof setTimeout>
  deadlineTimer?: ReturnType<typeof setTimeout>
  identity?: { rph: number; pid: number; creationTime: number }
}
type Pending = {
  requestId: number
  contentsId: number
  episodeId: string
  rph: number
  pid: number
  creationTime: number
  anchor: WebFrameMain
}
const episodes = new Map<number, Episode>()
const pending = new Map<string, Pending>()
let requestSequence = 0
let listening = false

function snapshotProcesses(): Map<number, number> | null {
  try {
    const metrics = app.getAppMetrics()
    return new Map(metrics.map((item) => [item.pid, item.creationTime]))
  } catch {
    return null
  }
}
function reconcile(snapshot: Map<number, number> | null): void {
  if (!snapshot) {
    return
  }
  for (const [key, owner] of pending) {
    const current = snapshot.get(owner.pid)
    if (current === undefined || (current > 0 && current !== owner.creationTime)) {
      pending.delete(key)
    }
  }
}
function publish(episode: Episode, status: RendererHangRecord['status']): void {
  const stacks = topHangStacks(episode.candidates, episode.record.validSamples)
  episode.record = { ...episode.record, stacks, status }
  publishRendererHang(getCanonicalUserDataPath(), episode.record)
}
function stopEpisode(contentsId: number, id: string): void {
  const episode = episodes.get(contentsId)
  if (!episode || episode.record.id !== id) {
    return
  }
  if (episode.timer) {
    clearTimeout(episode.timer)
  }
  if (episode.deadlineTimer) {
    clearTimeout(episode.deadlineTimer)
  }
  episode.record.completedAt = Date.now()
  publish(
    episode,
    episode.record.stacks.length
      ? 'captured'
      : episode.record.status === 'collecting'
        ? 'stopped'
        : episode.record.status
  )
  episodes.delete(contentsId)
}

export function reduceRendererHangStack(raw: unknown): {
  frames: HangStack['frames']
  status: RendererHangRecord['status']
  truncated: boolean
} {
  if (typeof raw !== 'string' || !raw) {
    return { frames: [], status: 'unavailable', truncated: false }
  }
  if (raw === 'Website owner has not opted in for JS call stacks in crash reports.') {
    return { frames: [], status: 'policy-missing', truncated: false }
  }
  const ingress = Buffer.from(raw.slice(0, 16 * 1024))
    .subarray(0, 16 * 1024)
    .toString('utf8')
  const truncated = ingress.length !== raw.length
  const lines = ingress.split('\n')
  if (truncated) {
    lines.pop()
  }
  const frames: HangStack['frames'] = []
  for (const line of lines.slice(0, 128)) {
    if (line.length > 512) {
      continue
    }
    const match = /^\s*at (?:(.+?) )?\(?(.*?):(\d+):(\d+)\)?\s*$/.exec(line)
    if (!match) {
      continue
    }
    const lineNumber = Number(match[3])
    const column = Number(match[4])
    if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column)) {
      continue
    }
    frames.push({
      name: hangLabel(match[1] || '(anonymous)'),
      module: hangModule(match[2]),
      line: lineNumber,
      column
    })
    if (frames.length === 8) {
      break
    }
  }
  return { frames, status: frames.length ? 'captured' : 'unavailable', truncated }
}

function settle(key: string, requestId: number, raw: unknown, rejected: boolean): void {
  const owner = pending.get(key)
  if (!owner || owner.requestId !== requestId) {
    return
  }
  pending.delete(key)
  const episode = episodes.get(owner.contentsId)
  if (!episode || episode.record.id !== owner.episodeId) {
    return
  }
  if (!resolveObservabilityConsent().localFileEnabled || performance.now() >= episode.deadline) {
    stopEpisode(owner.contentsId, owner.episodeId)
    return
  }
  const result = rejected
    ? { frames: [], status: 'failed' as const, truncated: false }
    : reduceRendererHangStack(raw)
  episode.record.samples++
  episode.record.truncated ||= result.truncated
  if (result.frames.length) {
    episode.record.validSamples++
    const signature = JSON.stringify(result.frames)
    const existing = episode.candidates.find((stack) => JSON.stringify(stack.frames) === signature)
    if (existing) {
      existing.count++
    } else {
      episode.candidates.push({ frames: result.frames, count: 1, hot: false })
    }
  }
  publish(episode, result.status)
  if (episode.attempts < 5) {
    episode.timer = setTimeout(() => request(owner.contentsId, owner.episodeId), 1000)
  } else {
    stopEpisode(owner.contentsId, owner.episodeId)
  }
}

function request(
  contentsId: number,
  episodeId: string,
  snapshot?: Map<number, number> | null
): void {
  const episode = episodes.get(contentsId)
  if (!episode || episode.record.id !== episodeId) {
    return
  }
  if (
    episode.attempts >= 5 ||
    performance.now() >= episode.deadline ||
    !resolveObservabilityConsent().localFileEnabled
  ) {
    stopEpisode(contentsId, episodeId)
    return
  }
  const contents = webContents.fromId(contentsId)
  if (!contents || contents.isDestroyed() || contents.isDevToolsOpened()) {
    stopEpisode(contentsId, episodeId)
    return
  }
  let frame: WebFrameMain
  let rph: number
  let pid: number
  try {
    frame = contents.mainFrame
    rph = frame.processId
    pid = frame.osProcessId
  } catch {
    stopEpisode(contentsId, episodeId)
    return
  }
  const metrics = episode.identity ? null : snapshot
  if (episode.identity && (episode.identity.rph !== rph || episode.identity.pid !== pid)) {
    stopEpisode(contentsId, episodeId)
    return
  }
  const creationTime = episode.identity?.creationTime ?? metrics?.get(pid)
  if (!creationTime || !Number.isFinite(creationTime) || creationTime <= 0) {
    publish(episode, 'unavailable')
    stopEpisode(contentsId, episodeId)
    return
  }
  const key = `${rph}:${pid}:${creationTime}`
  episode.identity = { rph, pid, creationTime }
  if (pending.has(key) || [...pending.values()].some((owner) => owner.contentsId === contentsId)) {
    publish(episode, 'process-capture-pending')
    stopEpisode(contentsId, episodeId)
    return
  }
  const requestId = ++requestSequence
  pending.set(key, { requestId, contentsId, episodeId, rph, pid, creationTime, anchor: frame })
  episode.attempts++
  try {
    void frame.collectJavaScriptCallStack().then(
      (raw) => settle(key, requestId, raw, false),
      () => settle(key, requestId, undefined, true)
    )
  } catch {
    settle(key, requestId, undefined, true)
  }
}

export function startRendererHangCapture(window: BrowserWindow): { stop: () => void } | null {
  if (!resolveObservabilityConsent().localFileEnabled || window.isDestroyed()) {
    return null
  }
  const contents = window.webContents
  if (contents.isDestroyed() || contents.isDevToolsOpened()) {
    return null
  }
  const contentsId = contents.id
  if (episodes.has(contentsId)) {
    return null
  }
  if (!listening) {
    listening = true
    app.on('render-process-gone', (_event, contents) => {
      if ([...pending.values()].some((owner) => owner.contentsId === contents.id)) {
        reconcile(snapshotProcesses())
      }
    })
  }
  const snapshot = snapshotProcesses()
  reconcile(snapshot)
  const detectedAt = Date.now()
  const id = `${process.pid}:${detectedAt}:${contentsId}`
  const episode: Episode = {
    record: {
      ...emptyHangStacks(),
      id,
      parentPid: process.pid,
      windowId: window.id,
      detectedAt,
      status: 'collecting'
    },
    deadline: performance.now() + 5000,
    attempts: 0,
    candidates: []
  }
  episodes.set(contentsId, episode)
  publish(episode, 'collecting')
  request(contentsId, id, snapshot)
  // Logical expiry leaves the single physical request/anchor owned until settlement or death.
  if (episodes.get(contentsId) === episode) {
    episode.deadlineTimer = setTimeout(() => stopEpisode(contentsId, id), 5000)
    episode.deadlineTimer.unref()
  }
  return { stop: () => stopEpisode(contentsId, id) }
}
