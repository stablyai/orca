import { shell } from 'electron'
import { z } from 'zod'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { emitBrowserExtensionEvent } from '../api-runtime/browser-extension-api-host'
import {
  BrowserExtensionApiError,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'
import {
  describeDownloadRecord,
  forgetDownloadRecord,
  ownDownloadRecord,
  ownDownloadRecords,
  readDownloadFileFacts,
  refreshDownloadRecord,
  savesRemotely,
  type DownloadRecord
} from './downloads-records'

const DEFAULT_QUERY_LIMIT = 1000

// Why strict: a query field Orca ignores would return items the extension did not ask for.
export const downloadQuerySchema = z
  .strictObject({
    id: z.number().int(),
    url: z.string(),
    filename: z.string(),
    state: z.enum(['in_progress', 'interrupted', 'complete']),
    limit: z.number().int().min(0)
  })
  .partial()

type DownloadQuery = z.infer<typeof downloadQuerySchema>

export function emitDownloadsEvent(
  caller: BrowserExtensionCaller,
  event: string,
  args: unknown[]
): void {
  emitBrowserExtensionEvent(
    { session: caller.session, extensionId: caller.extension.id },
    'downloads',
    event,
    args
  )
}

function matchingRecords(caller: BrowserExtensionCaller, query: DownloadQuery): DownloadRecord[] {
  const records = ownDownloadRecords(caller.session, caller.extension.id)
  // Why first: the state filter must see the state the item reports now.
  for (const record of records) {
    refreshDownloadRecord(record)
  }
  const matches = records.filter(
    (record) =>
      (query.id === undefined || record.id === query.id) &&
      (query.url === undefined || record.url === query.url) &&
      (query.filename === undefined || record.savePath === query.filename) &&
      (query.state === undefined || record.state === query.state)
  )
  const limit = query.limit ?? DEFAULT_QUERY_LIMIT
  return limit === 0 ? matches : matches.slice(0, limit)
}

export async function searchDownloads(caller: BrowserExtensionCaller, query: DownloadQuery) {
  const records = matchingRecords(caller, query)
  return Promise.all(
    records.map(async (record) =>
      describeDownloadRecord(record, await readDownloadFileFacts(record))
    )
  )
}

/** As in Chrome, an unknown or finished id is not a failure; another extension's is unknown. */
export async function cancelDownload(caller: BrowserExtensionCaller, id: number): Promise<void> {
  const record = ownDownloadRecord(caller.session, caller.extension.id, id)
  if (!record?.item) {
    return
  }
  try {
    if (!browserManager.cancelExtensionDownload(record.item)) {
      record.item.cancel()
    }
  } catch {
    return
  }
  await record.settled
}

/** Forgets matching records and returns their ids; the saved files stay on disk. */
export function eraseDownloads(caller: BrowserExtensionCaller, query: DownloadQuery): number[] {
  const records = matchingRecords(caller, query)
  // Why: Electron deletes a canceled download's partial file, and erase never deletes files.
  if (records.some((record) => record.item !== null)) {
    throw new BrowserExtensionApiError('Cancel in-progress downloads before erasing them')
  }
  for (const record of records) {
    forgetDownloadRecord(caller.session, record.id)
    emitDownloadsEvent(caller, 'onErased', [record.id])
  }
  return records.map((record) => record.id)
}

/** Never rejects: Chrome's show() returns nothing, and pages call it without awaiting. */
export async function showDownload(caller: BrowserExtensionCaller, id: number): Promise<void> {
  const record = ownDownloadRecord(caller.session, caller.extension.id, id)
  // Why not remote: its local path is only staging.
  if (!record || savesRemotely(record) || !(await readDownloadFileFacts(record)).exists) {
    return
  }
  try {
    shell.showItemInFolder(record.savePath)
  } catch {
    // Revealing is best effort; the record and file are unchanged.
  }
}
