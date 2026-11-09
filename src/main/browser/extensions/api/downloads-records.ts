import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'

export type ChromeDownloadState = 'in_progress' | 'interrupted' | 'complete'
export type ChromeDownloadError =
  | 'USER_CANCELED'
  | 'USER_SHUTDOWN'
  | 'NETWORK_FAILED'
  | 'FILE_FAILED'
  | 'FILE_BLOCKED'

/**
 * One chrome.downloads item, kept in main for the profile session that started it. Records live
 * until erase() or Orca quits (Electron keeps no download history), so they outlast worker restarts.
 */
export type DownloadRecord = {
  id: number
  extensionId: string
  url: string
  finalUrl: string
  mime: string
  startTime: string
  endTime: string | undefined
  state: ChromeDownloadState
  error: ChromeDownloadError | undefined
  paused: boolean
  canResume: boolean
  bytesReceived: number
  totalBytes: number
  savePath: string
  /** Routed to a remote workspace: savePath is only local staging, so it has no file facts. */
  remote: boolean
  /** Cleared when settled: Electron may destroy a finished item, so its last values are copied first. */
  item: Electron.DownloadItem | null
  settled: Promise<void>
}

type FileFacts = { exists: boolean; size: number | null }

const recordsBySession = new WeakMap<Electron.Session, Map<number, DownloadRecord>>()

function chromeState(item: Electron.DownloadItem): ChromeDownloadState {
  const state = item.getState()
  return state === 'completed'
    ? 'complete'
    : state === 'progressing'
      ? 'in_progress'
      : 'interrupted'
}

// Why the chain: getURL is the URL after redirects; Chrome's `url` is the one requested.
export function requestedUrl(item: Electron.DownloadItem): string {
  return item.getURLChain()[0] ?? item.getURL()
}

/** Copies the item's current values; a destroyed item keeps the last ones read. */
export function refreshDownloadRecord(record: DownloadRecord): void {
  const item = record.item
  if (!item) {
    return
  }
  try {
    const state = chromeState(item)
    // Why: a remote save ends after Electron's done, so only settling completes a record.
    record.state = state === 'complete' ? record.state : state
    record.finalUrl = item.getURL()
    record.mime = item.getMimeType()
    record.paused = item.isPaused()
    record.canResume = item.canResume()
    record.bytesReceived = item.getReceivedBytes()
    record.totalBytes = item.getTotalBytes()
    record.savePath = item.getSavePath() || record.savePath
  } catch {
    // The item was destroyed; keep the values already copied.
  }
}

/** Why from the event: Electron names no interrupt reason, and NETWORK_FAILED is Chrome's closest. */
export function noteDownloadUpdate(
  record: DownloadRecord,
  state: 'progressing' | 'interrupted'
): void {
  refreshDownloadRecord(record)
  record.error = state === 'interrupted' ? 'NETWORK_FAILED' : undefined
}

/** Chrome's reason for how Orca ended an item, or null when it completed. */
export function finishedDownloadError(
  record: DownloadRecord,
  status: 'completed' | 'canceled' | 'failed',
  doneState: string | null,
  cause: 'shutdown' | undefined
): ChromeDownloadError | null {
  if (status === 'completed') {
    return null
  }
  if (status === 'canceled') {
    return cause === 'shutdown' ? 'USER_SHUTDOWN' : 'USER_CANCELED'
  }
  // Why keep an interruption's reason: Orca cancels an interruption it cannot resume, not the user.
  return record.error ?? (doneState === 'interrupted' ? 'NETWORK_FAILED' : 'FILE_FAILED')
}

/** With error null the record completed; remote when it was routed to a remote workspace. */
export function settleDownloadRecord(
  record: DownloadRecord,
  error: ChromeDownloadError | null,
  remote = false
): void {
  refreshDownloadRecord(record)
  record.state = error ? 'interrupted' : 'complete'
  record.error = error ?? undefined
  record.remote = remote
  record.paused = false
  record.canResume = false
  record.endTime = new Date().toISOString()
  record.item = null
}

type DownloadDeltaFields = Pick<DownloadRecord, 'state' | 'error'>

/** Chrome's onChanged delta for the fields Orca reports, or null when none changed. */
export function downloadRecordDelta(previous: DownloadDeltaFields, record: DownloadRecord) {
  const delta: Partial<Record<keyof DownloadDeltaFields, { previous?: string; current?: string }>> =
    {}
  for (const key of ['state', 'error'] as const) {
    if (record[key] !== previous[key]) {
      delta[key] = {
        ...(previous[key] ? { previous: previous[key] } : {}),
        ...(record[key] ? { current: record[key] } : {})
      }
    }
  }
  return Object.keys(delta).length > 0 ? { id: record.id, ...delta } : null
}

export function createDownloadRecord(
  session: Electron.Session,
  extensionId: string,
  id: number,
  item: Electron.DownloadItem,
  savePath: string,
  settled: Promise<void>
): DownloadRecord {
  const record: DownloadRecord = {
    id,
    extensionId,
    url: requestedUrl(item),
    finalUrl: item.getURL(),
    mime: '',
    startTime: new Date(item.getStartTime() * 1000).toISOString(),
    endTime: undefined,
    state: 'in_progress',
    error: undefined,
    paused: false,
    canResume: false,
    bytesReceived: 0,
    totalBytes: 0,
    savePath,
    remote: false,
    item,
    settled
  }
  refreshDownloadRecord(record)
  let records = recordsBySession.get(session)
  if (!records) {
    records = new Map()
    recordsBySession.set(session, records)
  }
  records.set(id, record)
  return record
}

/** Only the caller's own records: an extension never sees another's or another profile's. */
export function ownDownloadRecords(
  session: Electron.Session,
  extensionId: string
): DownloadRecord[] {
  return [...(recordsBySession.get(session)?.values() ?? [])].filter(
    (record) => record.extensionId === extensionId
  )
}

export function ownDownloadRecord(
  session: Electron.Session,
  extensionId: string,
  id: number
): DownloadRecord | null {
  const record = recordsBySession.get(session)?.get(id)
  return record?.extensionId === extensionId ? record : null
}

export function forgetDownloadRecord(session: Electron.Session, id: number): void {
  recordsBySession.get(session)?.delete(id)
}

function factsFromStats(stats: Stats | null): FileFacts {
  return stats?.isFile() ? { exists: true, size: stats.size } : { exists: false, size: null }
}

/** Why ask the manager: until a remote save settles, savePath is only its local staging copy. */
export function savesRemotely(record: DownloadRecord): boolean {
  return (
    record.remote || (record.item !== null && browserManager.downloadSavesRemotely(record.item))
  )
}

export async function readDownloadFileFacts(record: DownloadRecord): Promise<FileFacts> {
  // Why as main reports: Orca cannot read the remote file, and the local path is only staging.
  if (savesRemotely(record)) {
    return { exists: record.state !== 'interrupted', size: null }
  }
  if (!record.savePath) {
    return { exists: false, size: null }
  }
  return factsFromStats(await stat(record.savePath).catch(() => null))
}

/** Chrome's DownloadItem; `exists` and a finished `fileSize` come from the file on disk. */
export function describeDownloadRecord(record: DownloadRecord, file: FileFacts) {
  const totalBytes = record.totalBytes > 0 ? record.totalBytes : -1
  return {
    id: record.id,
    url: record.url,
    finalUrl: record.finalUrl,
    referrer: '',
    filename: record.savePath,
    incognito: false,
    danger: 'safe',
    mime: record.mime,
    startTime: record.startTime,
    ...(record.endTime ? { endTime: record.endTime } : {}),
    ...(record.error ? { error: record.error } : {}),
    state: record.state,
    paused: record.paused,
    canResume: record.canResume,
    bytesReceived: record.bytesReceived,
    totalBytes,
    fileSize: record.state === 'complete' && file.size !== null ? file.size : totalBytes,
    exists: file.exists,
    byExtensionId: record.extensionId
  }
}
