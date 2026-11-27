// Sealed relay entries kept one file each in a folder, so changing one entry writes only that entry:
// a whole-file rewrite per change would grow with every kept chat. Each write is durable (temp file
// flushed, then renamed), and changes to one entry run in order, so a later one never lands under an
// earlier one.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { jsonObject } from '../../../shared/json-stream/json-value-property'
import { durableWriteTempPath, writeFileDurable } from '../../filesystem/durable-file-write'

const ENTRY_FILE = /^[0-9a-f]{64}\.json$/
/** Files read at once at startup, so a large folder never opens every file together. */
const READ_BATCH = 32

export type RelaySealedEntryFiles = {
  publish: (path: string, payload: string) => Promise<unknown>
  remove: (path: string) => Promise<unknown>
}

const durableFiles: RelaySealedEntryFiles = {
  publish: (path, payload) => writeFileDurable(durableWriteTempPath(path), path, payload, 0o600),
  remove: (path) => rm(path, { force: true })
}

export class RelaySealedEntries<Entry> {
  /** Each entry file's latest change; the next one waits for it. */
  private readonly pending = new Map<string, Promise<void>>()
  private made: Promise<unknown> | null = null

  constructor(
    private readonly directory: string,
    private readonly isEntry: (value: unknown) => value is Entry,
    /** What names an entry; one file per key. */
    private readonly keyOf: (entry: Entry) => string,
    private readonly files: RelaySealedEntryFiles = durableFiles
  ) {}

  /** Every readable entry; a missing folder holds none, and a bad file alone is skipped. */
  async read(): Promise<Entry[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch {
      return []
    }
    // A temp file another run left mid-write never published; it is never read.
    const ownRun = `.${process.pid}.`
    await Promise.all(
      names
        .filter((name) => name.endsWith('.tmp') && !name.includes(ownRun))
        .map((name) => rm(join(this.directory, name), { force: true }).catch(() => {}))
    )
    const entries: Entry[] = []
    const files = names.filter((name) => ENTRY_FILE.test(name))
    for (let start = 0; start < files.length; start += READ_BATCH) {
      const batch = files.slice(start, start + READ_BATCH)
      for (const entry of await Promise.all(batch.map((name) => this.readOne(name)))) {
        if (entry !== null) {
          entries.push(entry)
        }
      }
    }
    return entries
  }

  /** Resolves once the entry is durably on disk as given; rejects when that write failed. */
  put(entry: Entry): Promise<void> {
    const path = this.pathOf(this.keyOf(entry))
    const payload = `${JSON.stringify({ version: 1, entry })}\n`
    return this.after(path, async () => {
      this.made ??= mkdir(this.directory, { recursive: true, mode: 0o700 })
      await this.made.catch(() => {
        this.made = null
      })
      await this.files.publish(path, payload)
    })
  }

  /** Resolves once the entry's file is gone. */
  delete(entry: Entry): Promise<void> {
    const path = this.pathOf(this.keyOf(entry))
    return this.after(path, async () => {
      await this.files.remove(path)
    })
  }

  private after(path: string, change: () => Promise<void>): Promise<void> {
    const run = (this.pending.get(path) ?? Promise.resolve()).catch(() => {}).then(change)
    this.pending.set(path, run)
    const settled = (): void => {
      if (this.pending.get(path) === run) {
        this.pending.delete(path)
      }
    }
    run.then(settled, settled)
    return run
  }

  private pathOf(key: string): string {
    return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`)
  }

  private async readOne(name: string): Promise<Entry | null> {
    try {
      const parsed = jsonObject(JSON.parse(await readFile(join(this.directory, name), 'utf8')))
      const entry: unknown = parsed?.version === 1 ? parsed.entry : undefined
      // An entry only counts under its own name, so one key never has two files.
      return this.isEntry(entry) && this.pathOf(this.keyOf(entry)).endsWith(name) ? entry : null
    } catch {
      return null
    }
  }
}
