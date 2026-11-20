import { MAX_HANG_WORKER_SENDS, type HangWorkerSend } from './hang-observation-schema'

const TEXT_MAX_LENGTH = 40

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length <= TEXT_MAX_LENGTH ? value : null
}

/** Drops malformed sends; rejects the list only when it is not a bounded array. */
export function parseHangWorkerSends(value: unknown): HangWorkerSend[] | null {
  if (!Array.isArray(value) || value.length > MAX_HANG_WORKER_SENDS) {
    return null
  }
  const list: readonly unknown[] = value
  const sends: HangWorkerSend[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const field = (key: keyof HangWorkerSend): unknown =>
      Object.getOwnPropertyDescriptor(item, key)?.value
    const role = text(field('role'))
    const kind = text(field('kind'))
    const items = count(field('items'))
    const bytes = count(field('bytes'))
    const depth = count(field('depth'))
    const agoMs = count(field('agoMs'))
    const heapUsedMB = count(field('heapUsedMB'))
    if (
      role !== null &&
      kind !== null &&
      items !== null &&
      bytes !== null &&
      depth !== null &&
      agoMs !== null &&
      heapUsedMB !== null
    ) {
      sends.push({ role, kind, items, bytes, depth, agoMs, heapUsedMB })
    }
  }
  return sends
}
