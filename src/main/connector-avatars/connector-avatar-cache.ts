import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isConnectorAvatarUrl } from '../../shared/connector-message-asker'
import {
  fetchRemoteRepoIcon,
  type RepoIconFetch
} from '../runtime/sidebar-inputs/repo-icons/repo-icon-remote-fetch'

export type ConnectorAvatarImage = { data: Buffer; mimeType: string }

// The image types an avatar may be, told by their bytes rather than the server's header.
function imageMimeType(data: Buffer): string | null {
  if (data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return 'image/png'
  }
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg'
  }
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') {
    return 'image/gif'
  }
  if (
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

const FRESH_MS = 7 * 24 * 60 * 60_000
const FETCH_TIMEOUT_MS = 10_000
// A shown avatar is refetched weekly; one untouched this long is a URL no message uses now.
const UNUSED_MS = 30 * 24 * 60 * 60_000

/** Avatars fetched once per week per URL and kept on disk, so a chat never loads one remotely. */
export class ConnectorAvatarCache {
  private readonly inFlight = new Map<string, Promise<ConnectorAvatarImage | null>>()

  constructor(
    private readonly deps: {
      directory: () => string
      fetch: RepoIconFetch
      now: () => number
    }
  ) {}

  /** `url` must already be an allowed avatar URL. A failed refresh serves the stale copy. */
  read(url: string): Promise<ConnectorAvatarImage | null> {
    let pending = this.inFlight.get(url)
    if (!pending) {
      pending = this.load(url).finally(() => this.inFlight.delete(url))
      this.inFlight.set(url, pending)
    }
    return pending
  }

  private async load(url: string): Promise<ConnectorAvatarImage | null> {
    const key = createHash('sha256').update(url).digest('hex')
    const cached = await this.readCached(key)
    if (cached && this.deps.now() - cached.writtenAt < FRESH_MS) {
      return cached.image
    }
    const fetched = await this.fetchImage(url).catch(() => null)
    if (!fetched) {
      return cached?.image ?? null
    }
    await this.write(key, fetched).catch(() => undefined)
    return fetched
  }

  private async readCached(
    key: string
  ): Promise<{ image: ConnectorAvatarImage; writtenAt: number } | null> {
    const path = join(this.deps.directory(), key)
    try {
      const [data, info] = await Promise.all([readFile(path), stat(path)])
      const mimeType = imageMimeType(data)
      return mimeType ? { image: { data, mimeType }, writtenAt: info.mtimeMs } : null
    } catch {
      return null
    }
  }

  private async fetchImage(url: string): Promise<ConnectorAvatarImage | null> {
    // A redirect is followed only to another host an avatar may come from.
    const fetched = await fetchRemoteRepoIcon(url, this.deps.fetch, FETCH_TIMEOUT_MS, (hop) =>
      isConnectorAvatarUrl(hop.href)
    )
    const data = fetched ? Buffer.from(fetched.bytes) : null
    const mimeType = data ? imageMimeType(data) : null
    return data && mimeType ? { data, mimeType } : null
  }

  private async write(key: string, image: ConnectorAvatarImage): Promise<void> {
    const directory = this.deps.directory()
    await mkdir(directory, { recursive: true })
    const path = join(directory, key)
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, image.data)
    await rename(temporary, path)
    await this.pruneUnused(directory)
  }

  private async pruneUnused(directory: string): Promise<void> {
    const oldest = this.deps.now() - UNUSED_MS
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const info = await stat(path).catch(() => null)
      if (info && info.mtimeMs < oldest) {
        await rm(path, { force: true })
      }
    }
  }
}
