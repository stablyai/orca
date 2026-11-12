import type { WorkerTerminalListState } from '../../../../orchestration/terminal-authority/release/worker-terminal-ownership'

/** Order by databaseId; keep createdAt/dispatchId so older peers can decode new cursors. */
type WorkerListCursorAfter = { createdAt: string; dispatchId: string; databaseId?: number }

/** The first page's count of the pinned snapshot; later pages with the same scope repeat it instead of rescanning. */
export type WorkerListInventory = {
  total: number
  counts: Partial<Record<WorkerTerminalListState, number>>
  runId?: string
  terminalState?: WorkerTerminalListState
}

type WorkerListCursorV1 = {
  version: 1
  snapshot: { createdAt: string; dispatchId: string }
  after: WorkerListCursorAfter
  inventory?: WorkerListInventory
}

type WorkerListCursorV2 = {
  version: 2
  snapshot: { databaseId: number }
  after: WorkerListCursorAfter
  inventory?: WorkerListInventory
}

type WorkerListCursorV3 = {
  version: 3
  snapshot: { id: string }
  offset: number
}

type WorkerListCursor = WorkerListCursorV1 | WorkerListCursorV2 | WorkerListCursorV3

export function encodeWorkerListCursor(cursor: WorkerListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeWorkerListCursor(value: string): WorkerListCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as Partial<WorkerListCursor>
    if (!parsed.snapshot) {
      return null
    }
    if (
      parsed.version === 3 &&
      typeof (parsed.snapshot as Partial<WorkerListCursorV3['snapshot']>).id === 'string' &&
      (parsed.snapshot as WorkerListCursorV3['snapshot']).id.length > 0 &&
      Number.isSafeInteger((parsed as Partial<WorkerListCursorV3>).offset) &&
      Number((parsed as Partial<WorkerListCursorV3>).offset) >= 0
    ) {
      return parsed as WorkerListCursorV3
    }
    if (!('after' in parsed) || !parsed.after) {
      return null
    }
    if (
      'databaseId' in parsed.after &&
      !(Number.isSafeInteger(parsed.after.databaseId) && Number(parsed.after.databaseId) > 0)
    ) {
      delete parsed.after.databaseId
    }
    if ('inventory' in parsed && !isWorkerListInventory(parsed.inventory)) {
      delete parsed.inventory
    }
    if (
      parsed.version === 1 &&
      typeof (parsed.snapshot as Partial<WorkerListCursorV1['snapshot']>).createdAt === 'string' &&
      typeof (parsed.snapshot as Partial<WorkerListCursorV1['snapshot']>).dispatchId === 'string' &&
      typeof parsed.after.createdAt === 'string' &&
      typeof parsed.after.dispatchId === 'string'
    ) {
      return parsed as WorkerListCursorV1
    }
    const databaseId = (parsed.snapshot as Partial<WorkerListCursorV2['snapshot']>).databaseId
    if (
      parsed.version === 2 &&
      Number.isSafeInteger(databaseId) &&
      Number(databaseId) > 0 &&
      typeof parsed.after.createdAt === 'string' &&
      typeof parsed.after.dispatchId === 'string'
    ) {
      return parsed as WorkerListCursorV2
    }
    return null
  } catch {
    return null
  }
}

function isWorkerListInventory(value: unknown): value is WorkerListInventory {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is checked below before the value is trusted.
  const { total, counts, runId, terminalState } = value as Partial<WorkerListInventory>
  return (
    (runId === undefined || typeof runId === 'string') &&
    (terminalState === undefined || typeof terminalState === 'string') &&
    Number.isSafeInteger(total) &&
    Number(total) >= 0 &&
    typeof counts === 'object' &&
    counts !== null &&
    Object.values(counts).every((count) => Number.isSafeInteger(count) && Number(count) >= 0)
  )
}

export type { WorkerListCursor }
