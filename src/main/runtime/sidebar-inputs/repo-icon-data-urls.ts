import { createHash } from 'node:crypto'
import type { RepoIcon } from '../../../shared/repo-icon'
import type { Repo } from '../../../shared/repo-types'
import { readRasterImageDimensions } from '../../../shared/raster-image-dimensions'
import {
  MAX_REPO_ICON_DATA_URL_BYTES,
  repoIconFeedKey,
  type RepoIconDataUrlsReply
} from '../../../shared/sidebar-list/repo-icon-data-urls-contract'
import {
  fetchRemoteRepoIcon,
  type FetchedRepoIcon,
  type RepoIconFetch
} from './repo-icon-remote-fetch'
import type { RuntimeDesktopSurface } from '../runtime-desktop-surface'

export type RepoIconPngEncoder = NonNullable<RuntimeDesktopSurface['encodeRepoIconPng']>

// Why two decode caps: fetched bytes are untrusted; local icons were picked by the user and already
// show on the desktop, so only a decode-bomb bound applies.
const MAX_REMOTE_DECODE_EDGE_PX = 512
const MAX_LOCAL_DECODE_EDGE_PX = 2048
const ENCODED_EDGES_PX = [64, 32]
const SUCCESS_TTL_MS = 60 * 60 * 1000
const FAILURE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_BYTES = 1024 * 1024
const CACHE_ENTRY_OVERHEAD_BYTES = 128
// Why 4: a lone 16-id read of slow hosts then ends within 20 s, under the phone's 30 s timeout.
const MAX_CONCURRENT_FETCHES = 4

type ImageRepoIcon = Extract<RepoIcon, { type: 'image' }>
type CacheEntry = { dataUrl: string | null; expiresAt: number }

/** Content-addressed, so repos sharing an avatar share one id and a changed icon gets a new one. */
export function repoIconId(icon: RepoIcon | null | undefined): string | null {
  if (icon?.type !== 'image') {
    return null
  }
  return createHash('sha256').update(`${icon.source}\n${icon.src}`).digest('base64url').slice(0, 22)
}

function decodeDataUrl(src: string): FetchedRepoIcon | null {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(src)
  return match ? { mimeType: match[1].toLowerCase(), bytes: Buffer.from(match[2], 'base64') } : null
}

function asDataUrl(mimeType: string, bytes: Uint8Array): string | null {
  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
  return dataUrl.length <= MAX_REPO_ICON_DATA_URL_BYTES ? dataUrl : null
}

/**
 * The workspace icons the window shows (each repo's `repoIcon`), as small data URLs a phone can
 * draw even where its shell admits no https images. Without an encoder (orcad) small images pass
 * through unchanged and larger ones fall back.
 */
export class RepoIconDataUrls {
  private readonly cache = new Map<string, CacheEntry & { bytes: number }>()
  private readonly inFlight = new Map<string, Promise<string | null>>()
  private idsBySrc = new Map<string, { source: string; id: string }>()
  private cacheBytes = 0
  private activeFetches = 0
  private readonly fetchQueue: (() => void)[] = []

  constructor(
    private readonly options: {
      repos: () => readonly Repo[]
      fetch: RepoIconFetch
      encoder: () => RepoIconPngEncoder | undefined
      now?: () => number
      fetchTimeoutMs?: number
    }
  ) {}

  async read(ids: readonly string[]): Promise<RepoIconDataUrlsReply> {
    const icons = this.currentIcons()
    const dataUrls = await Promise.all(ids.map((id) => this.dataUrlFor(id, icons.get(id))))
    return { icons: ids.map((id, index) => ({ id, dataUrl: dataUrls[index] })) }
  }

  /** Each repo's icon id by `hostId|repoId`, which the feed publishes; repos without an image are absent. */
  idsByRepo(): Record<string, string> {
    return Object.fromEntries(
      this.identifiedIcons().map(({ repo, id }) => [repoIconFeedKey(repo), id])
    )
  }

  private currentIcons(): Map<string, ImageRepoIcon> {
    return new Map(this.identifiedIcons().map(({ icon, id }) => [id, icon]))
  }

  private identifiedIcons(): { repo: Repo; icon: ImageRepoIcon; id: string }[] {
    const identified: { repo: Repo; icon: ImageRepoIcon; id: string }[] = []
    const idsBySrc = new Map<string, { source: string; id: string }>()
    for (const repo of this.options.repos()) {
      const { repoIcon } = repo
      if (repoIcon?.type !== 'image') {
        continue
      }
      // Why keyed by the src itself: an upload's src is up to 400 KB, and hydration keeps handing
      // back the same string, so its hash is cached on it instead of re-hashing every read.
      const known = this.idsBySrc.get(repoIcon.src)
      const id = known?.source === repoIcon.source ? known.id : repoIconId(repoIcon)
      if (id) {
        idsBySrc.set(repoIcon.src, { source: repoIcon.source, id })
        identified.push({ repo, icon: repoIcon, id })
      }
    }
    this.idsBySrc = idsBySrc
    return identified
  }

  private dataUrlFor(id: string, icon: ImageRepoIcon | undefined): Promise<string | null> {
    if (!icon) {
      return Promise.resolve(null)
    }
    const now = this.now()
    const cached = this.cache.get(id)
    if (cached && cached.expiresAt > now) {
      this.cache.delete(id)
      this.cache.set(id, cached)
      return Promise.resolve(cached.dataUrl)
    }
    const pending = this.inFlight.get(id)
    if (pending) {
      return pending
    }
    const produced = this.produce(icon)
      .catch(() => null)
      .then((dataUrl) => {
        this.inFlight.delete(id)
        this.remember(id, dataUrl)
        return dataUrl
      })
    this.inFlight.set(id, produced)
    return produced
  }

  private async produce(icon: ImageRepoIcon): Promise<string | null> {
    const remote = icon.src.startsWith('https:')
    const image = remote ? await this.fetchLimited(icon.src) : decodeDataUrl(icon.src)
    if (!image) {
      return null
    }
    const dimensions = readRasterImageDimensions(image.bytes)
    const maxEdge = remote ? MAX_REMOTE_DECODE_EDGE_PX : MAX_LOCAL_DECODE_EDGE_PX
    if (!dimensions || dimensions.width > maxEdge || dimensions.height > maxEdge) {
      return null
    }
    // Why pass through when encoding fails: Electron decodes only PNG and JPEG everywhere, and
    // a small GIF, WebP or ICO the phone can draw must not show worse than on orcad.
    return this.encodeFitting(image.bytes) ?? asDataUrl(image.mimeType, image.bytes)
  }

  private encodeFitting(bytes: Uint8Array): string | null {
    const encode = this.options.encoder()
    if (!encode) {
      return null
    }
    for (const edge of ENCODED_EDGES_PX) {
      const png = encode(bytes, edge)
      if (!png) {
        return null
      }
      const dataUrl = asDataUrl('image/png', png)
      if (dataUrl) {
        return dataUrl
      }
    }
    return null
  }

  private async fetchLimited(url: string): Promise<FetchedRepoIcon | null> {
    if (this.activeFetches < MAX_CONCURRENT_FETCHES) {
      this.activeFetches += 1
    } else {
      // Why no increment after waking: the finishing fetch hands over its slot.
      await new Promise<void>((resolve) => this.fetchQueue.push(resolve))
    }
    try {
      return await fetchRemoteRepoIcon(url, this.options.fetch, this.options.fetchTimeoutMs)
    } finally {
      const next = this.fetchQueue.shift()
      if (next) {
        next()
      } else {
        this.activeFetches -= 1
      }
    }
  }

  private remember(id: string, dataUrl: string | null): void {
    this.forget(id)
    // Why a floor: misses must count too, or they could pile up uncapped.
    const bytes = (dataUrl?.length ?? 0) + CACHE_ENTRY_OVERHEAD_BYTES
    const ttl = dataUrl ? SUCCESS_TTL_MS : FAILURE_TTL_MS
    this.cache.set(id, { dataUrl, expiresAt: this.now() + ttl, bytes })
    this.cacheBytes += bytes
    for (const oldest of this.cache.keys()) {
      if (this.cacheBytes <= MAX_CACHE_BYTES) {
        break
      }
      this.forget(oldest)
    }
  }

  private forget(id: string): void {
    const entry = this.cache.get(id)
    if (entry) {
      this.cacheBytes -= entry.bytes
      this.cache.delete(id)
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
