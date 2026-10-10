import {
  cacheKey,
  classifyHost,
  dedupeChangeEvents,
  formatHostForOrigin,
  isDefaultPort,
  isUnspecifiedHost,
  shouldReplace,
  worktreeIdFromCacheKey,
  type CacheKey,
  type ListenerScanState
} from './advertised-url-parsing'
import type { AdvertisedUrl, AdvertisedUrlChangeEvent } from './advertised-url-watcher'

export function considerAdvertisedUrl(args: {
  url: URL
  ptyId: string
  worktreeId: string
  timestamp: number
  cache: Map<CacheKey, AdvertisedUrl>
  validationBaselines: Map<CacheKey, ListenerScanState>
  startupAbsentAllowances: Set<CacheKey>
  currentScanState: ListenerScanState | undefined
  maxCacheEntries: number
}): AdvertisedUrlChangeEvent[] {
  const protocol = args.url.protocol === 'https:' ? 'https' : 'http'
  const port = args.url.port ? Number(args.url.port) : protocol === 'https' ? 443 : 80
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return []
  }
  const hostname = args.url.hostname
  if (isUnspecifiedHost(hostname)) {
    return []
  }
  const candidate: AdvertisedUrl = {
    origin: `${protocol}://${formatHostForOrigin(args.url)}${isDefaultPort(protocol, port) ? '' : `:${port}`}`,
    host: hostname,
    hostKind: classifyHost(hostname),
    protocol,
    port,
    ptyId: args.ptyId,
    lastSeenAt: args.timestamp
  }
  const key = cacheKey(args.worktreeId, port)
  const existing = args.cache.get(key)
  if (existing && !shouldReplace(existing, candidate)) {
    existing.lastSeenAt = args.timestamp
    return []
  }

  args.cache.set(key, candidate)
  if (args.currentScanState) {
    args.validationBaselines.set(key, args.currentScanState)
    if (args.currentScanState.kind === 'absent') {
      args.startupAbsentAllowances.add(key)
    } else {
      args.startupAbsentAllowances.delete(key)
    }
  } else {
    args.validationBaselines.delete(key)
    args.startupAbsentAllowances.add(key)
  }
  const changedEvents = enforceAdvertisedUrlCacheLimit(args)
  if (!existing || existing.origin !== candidate.origin) {
    changedEvents.push({ worktreeId: args.worktreeId, port })
  }
  return dedupeChangeEvents(changedEvents)
}

function enforceAdvertisedUrlCacheLimit(args: {
  cache: Map<CacheKey, AdvertisedUrl>
  validationBaselines: Map<CacheKey, ListenerScanState>
  startupAbsentAllowances: Set<CacheKey>
  maxCacheEntries: number
}): AdvertisedUrlChangeEvent[] {
  if (args.cache.size <= args.maxCacheEntries) {
    return []
  }
  const entries = Array.from(args.cache.entries()).sort(
    (left, right) => left[1].lastSeenAt - right[1].lastSeenAt
  )
  const overflow = args.cache.size - args.maxCacheEntries
  const removedEvents: AdvertisedUrlChangeEvent[] = []
  for (let index = 0; index < overflow; index++) {
    const [key, entry] = entries[index]
    args.cache.delete(key)
    args.validationBaselines.delete(key)
    args.startupAbsentAllowances.delete(key)
    removedEvents.push({
      worktreeId: worktreeIdFromCacheKey(key, entry.port),
      port: entry.port
    })
  }
  return removedEvents
}
