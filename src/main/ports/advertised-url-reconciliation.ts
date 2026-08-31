import {
  cacheKey,
  scanStateChanged,
  shouldReplace,
  type CacheKey,
  type ListenerScanState
} from './advertised-url-parsing'
import type { AdvertisedUrl } from './advertised-url-watcher'

export function shouldEvictAdvertisedUrlAfterScan(args: {
  key: CacheKey
  entry: AdvertisedUrl
  current: ListenerScanState
  validationBaselines: Map<CacheKey, ListenerScanState>
  startupAbsentAllowances: Set<CacheKey>
}): boolean {
  const baseline = args.validationBaselines.get(args.key)
  if (args.current.kind === 'absent') {
    if (
      args.entry.validatedListenerPid === undefined &&
      baseline?.kind !== 'present' &&
      args.startupAbsentAllowances.delete(args.key)
    ) {
      return false
    }
    return true
  }
  if (
    args.entry.validatedListenerPid !== undefined &&
    args.current.pid !== undefined &&
    args.entry.validatedListenerPid !== args.current.pid
  ) {
    return true
  }
  if (baseline?.kind === 'absent') {
    args.startupAbsentAllowances.delete(args.key)
    return false
  }
  return (
    args.entry.validatedListenerPid === undefined &&
    baseline !== undefined &&
    scanStateChanged(baseline, args.current)
  )
}

export function lookupBestAdvertisedUrl(args: {
  worktreeIds: readonly string[]
  port: number
  currentListenerPid?: number
  cache: Map<CacheKey, AdvertisedUrl>
  validationBaselines: Map<CacheKey, ListenerScanState>
  startupAbsentAllowances: Set<CacheKey>
  onEvict: (worktreeId: string) => void
}): AdvertisedUrl | undefined {
  let best: { worktreeId: string; entry: AdvertisedUrl } | undefined
  for (const worktreeId of args.worktreeIds) {
    const key = cacheKey(worktreeId, args.port)
    const candidate = args.cache.get(key)
    if (!candidate) {
      continue
    }
    if (
      args.currentListenerPid !== undefined &&
      candidate.validatedListenerPid !== undefined &&
      candidate.validatedListenerPid !== args.currentListenerPid
    ) {
      args.cache.delete(key)
      args.validationBaselines.delete(key)
      args.startupAbsentAllowances.delete(key)
      args.onEvict(worktreeId)
      continue
    }
    if (!best || shouldReplace(best.entry, candidate)) {
      best = { worktreeId, entry: candidate }
    }
  }
  if (
    best &&
    args.currentListenerPid !== undefined &&
    best.entry.validatedListenerPid === undefined
  ) {
    best.entry.validatedListenerPid = args.currentListenerPid
    args.validationBaselines.delete(cacheKey(best.worktreeId, args.port))
    args.startupAbsentAllowances.delete(cacheKey(best.worktreeId, args.port))
  }
  return best?.entry
}
