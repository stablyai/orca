import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'

/** One directory read: the names it holds, or what stopped the read. */
export type SessionSearchDirectoryListing =
  | { listed: true; names: ReadonlySet<string> }
  | { listed: false; code: string | null; message: string }

/**
 * What the retirement walk needs of a directory: its names, or why not.
 *
 * An interface rather than the class, so a test can hand the walk an EIO or a
 * gate refusal — the shapes a stalled network mount answers with, which no
 * temporary directory can be made to produce.
 */
export type SessionSearchDirectoryReader = {
  namesIn(directory: string, signal?: AbortSignal): Promise<SessionSearchDirectoryListing>
}

/**
 * Every directory one pass had to read, read once.
 *
 * The retirement walk asks the same directories about many files — a project
 * directory holds hundreds of transcripts — and under an unmount every path
 * under a root walks up through the same ancestors. One readdir per directory
 * per pass keeps that bounded, and it also makes the pass self-consistent: two
 * files in one directory cannot get contradictory verdicts because the
 * directory changed between them.
 *
 * Reads go through the same gated primitive discovery uses, so a WSL UNC path
 * is routed to the distro's helper process rather than read with raw fs, and a
 * gate refusal arrives as an error rather than as an empty directory.
 */
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

  /** Directories read this pass; only tests and cost accounting need it. */
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
