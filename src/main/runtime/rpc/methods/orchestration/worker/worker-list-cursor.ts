/** v4 requires `after.databaseId` so a replaced Dispatch cannot be re-resolved by id.
 *  v1/v2 stay decodable so callers can expire them instead of reinterpreting ascending cursors. */
type WorkerListCursorAfter = { createdAt: string; dispatchId: string; databaseId?: number }

type WorkerListCursorV1 = {
  version: 1
  snapshot: { createdAt: string; dispatchId: string }
  after: WorkerListCursorAfter
}

type WorkerListCursorV2 = {
  version: 2
  snapshot: { databaseId: number }
  after: WorkerListCursorAfter
}

type WorkerListCursorV3 = {
  version: 3
  snapshot: { id: string }
  offset: number
}

type WorkerListCursorV4 = {
  version: 4
  snapshot: { databaseId: number }
  after: { createdAt: string; dispatchId: string; databaseId: number }
}

type WorkerListCursor =
  | WorkerListCursorV1
  | WorkerListCursorV2
  | WorkerListCursorV3
  | WorkerListCursorV4

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
    const afterDatabaseId = parsed.after.databaseId
    if (
      parsed.version === 2 &&
      Number.isSafeInteger(databaseId) &&
      Number(databaseId) > 0 &&
      typeof parsed.after.createdAt === 'string' &&
      typeof parsed.after.dispatchId === 'string'
    ) {
      return parsed as WorkerListCursorV2
    }
    if (
      parsed.version === 4 &&
      Number.isSafeInteger(databaseId) &&
      Number(databaseId) > 0 &&
      Number.isSafeInteger(afterDatabaseId) &&
      Number(afterDatabaseId) > 0 &&
      typeof parsed.after.createdAt === 'string' &&
      typeof parsed.after.dispatchId === 'string'
    ) {
      return {
        version: 4,
        snapshot: { databaseId: Number(databaseId) },
        after: {
          createdAt: parsed.after.createdAt,
          dispatchId: parsed.after.dispatchId,
          databaseId: Number(afterDatabaseId)
        }
      }
    }
    return null
  } catch {
    return null
  }
}

export type { WorkerListCursor }
