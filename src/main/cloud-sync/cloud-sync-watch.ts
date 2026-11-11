// The cloud's file watch, read for sync: which workspace paths changed, or that a rescan is
// needed (overflow, or a directory event that can stand for many files). Events come from the VM
// and are validated like any other reply.
import { z } from 'zod'
import { isContextPath, isSafeSyncPath } from './cloud-sync-paths'
import { relativeToRoot } from './cloud-sync-remote'

const ChangeSchema = z.looseObject({
  kind: z.string().optional(),
  absolutePath: z.unknown().optional(),
  oldAbsolutePath: z.unknown().optional(),
  isDirectory: z.boolean().optional()
})
const WatchEventSchema = z.looseObject({
  type: z.string(),
  events: z.array(z.unknown()).optional()
})

export type WatchSubscription = { close: () => void }
export type WatchSubscribe = (
  selector: string,
  handlers: { onEvent: (event: unknown) => void; onClose: () => void }
) => Promise<WatchSubscription>

export type WatchBatch =
  | { kind: 'ready' }
  | { kind: 'rescan' }
  | { kind: 'paths'; paths: string[] }
  | { kind: 'none' }

export function readWatchEvent(event: unknown, root: string, mirror: boolean): WatchBatch {
  const parsed = WatchEventSchema.safeParse(event)
  if (!parsed.success) {
    return { kind: 'none' }
  }
  if (parsed.data.type === 'ready') {
    return { kind: 'ready' }
  }
  if (parsed.data.type !== 'changed' || !parsed.data.events) {
    return { kind: 'none' }
  }
  const paths: string[] = []
  for (const raw of parsed.data.events) {
    const change = ChangeSchema.safeParse(raw)
    if (!change.success) {
      continue
    }
    if (change.data.kind === 'overflow' || change.data.isDirectory === true) {
      return { kind: 'rescan' }
    }
    for (const candidate of [change.data.absolutePath, change.data.oldAbsolutePath]) {
      const rel = relativeToRoot(root, candidate)
      if (rel && isSafeSyncPath(rel) && (mirror || isContextPath(rel))) {
        paths.push(rel)
      }
    }
  }
  return paths.length > 0 ? { kind: 'paths', paths } : { kind: 'none' }
}

const DEBOUNCE_MS = 800
const MAX_WAIT_MS = 5_000
/** More changed paths than this in one burst (a checkout, an install) is cheaper as a full pass. */
const MAX_PATHS = 400

/** Collects changed paths for a short quiet period (bounded wait), then hands them over. */
export function createChangeBatcher(handlers: {
  onPaths: (paths: string[]) => void
  onRescan: () => void
  now?: () => number
}) {
  const now = handlers.now ?? Date.now
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let since = 0

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = null
  }
  const flush = (): void => {
    cancel()
    const paths = [...dirty]
    dirty.clear()
    if (paths.length > 0) {
      handlers.onPaths(paths)
    }
  }
  return {
    add(paths: readonly string[]): void {
      for (const path of paths) {
        dirty.add(path)
      }
      if (dirty.size > MAX_PATHS) {
        this.rescan()
        return
      }
      if (timer === null) {
        since = now()
      }
      cancel()
      timer = setTimeout(flush, Math.max(0, Math.min(DEBOUNCE_MS, since + MAX_WAIT_MS - now())))
      timer.unref?.()
    },
    rescan(): void {
      cancel()
      dirty.clear()
      handlers.onRescan()
    },
    /** A full pass covers whatever was waiting. */
    clear(): void {
      cancel()
      dirty.clear()
    },
    dispose(): void {
      cancel()
      dirty.clear()
    }
  }
}
