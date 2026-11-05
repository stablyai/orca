import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'

export type SessionSearchDirectoryListing =
  | { listed: true; names: ReadonlySet<string> }
  | { listed: false; code: string | null; message: string }

export type SessionSearchDirectoryReader = {
  namesIn(directory: string, signal?: AbortSignal): Promise<SessionSearchDirectoryListing>
}

/** Reuse per-pass directory verdicts so retirement rows share consistent evidence. */
export class SessionSearchDirectoryListings implements SessionSearchDirectoryReader {
  private readonly listings = new Map<string, SessionSearchDirectoryListing>()

  async namesIn(directory: string, signal?: AbortSignal): Promise<SessionSearchDirectoryListing> {
    const cached = this.listings.get(directory)
    if (cached) {
      return cached
    }
    const listing = await readDirectory(directory, signal)
    this.listings.set(directory, listing)
    return listing
  }

  get size(): number {
    return this.listings.size
  }
}

async function readDirectory(
  directory: string,
  signal?: AbortSignal
): Promise<SessionSearchDirectoryListing> {
  try {
    const entries = await wslGatedReaddir(directory, 'scan', signal)
    return { listed: true, names: new Set(entries.map((entry) => entry.name)) }
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : null
    return {
      listed: false,
      code,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
