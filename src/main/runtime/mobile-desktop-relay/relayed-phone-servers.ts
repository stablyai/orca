import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../../filesystem/durable-file-write'

const FILE_NAME = 'relayed-phone-servers.json'

/** Servers that may hold this desktop's relayed phones. Kept across launches, so a phone unpaired
 *  while the desktop was closed or the server unreachable is still sent on the next contact, and a
 *  server that never held one is never sent anything. Only a durable write changes the answer. */
export class RelayedPhoneServers {
  private readonly path: string
  private ids: Promise<ReadonlySet<string>>
  private writes: Promise<unknown> = Promise.resolve()

  constructor(userDataPath: string) {
    this.path = join(userDataPath, FILE_NAME)
    this.ids = readIds(this.path)
  }

  async has(environmentId: string): Promise<boolean> {
    return (await this.ids).has(environmentId)
  }

  async list(): Promise<string[]> {
    return [...(await this.ids)]
  }

  /** Rejects when the write fails; a sync that would mint a phone there must not go out then. */
  set(environmentId: string, holdsPhones: boolean): Promise<void> {
    return this.update((ids) => {
      if (ids.has(environmentId) === holdsPhones) {
        return null
      }
      const next = new Set(ids)
      if (holdsPhones) {
        next.add(environmentId)
      } else {
        next.delete(environmentId)
      }
      return next
    })
  }

  /** Forget servers no longer configured here: this desktop can never reach them again. Read in
   *  the write queue, so a server recorded meanwhile is already in the configured list. */
  retain(readConfigured: () => Promise<ReadonlySet<string>>): Promise<void> {
    return this.update(async (ids) => {
      const configured = await readConfigured()
      return [...ids].every((id) => configured.has(id))
        ? null
        : new Set([...ids].filter((id) => configured.has(id)))
    })
  }

  // `change` returns null when the record already says so: nothing is copied or written.
  private update(
    change: (ids: ReadonlySet<string>) => Set<string> | null | Promise<Set<string> | null>
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const next = await change(await this.ids)
      if (!next) {
        return
      }
      await writeFileDurable(
        durableWriteTempPath(this.path),
        this.path,
        JSON.stringify([...next]),
        0o600
      )
      this.ids = Promise.resolve(next)
    })
    this.writes = write.catch((error: unknown) => {
      console.warn('[mobile-relay] Could not save the servers holding relayed phones:', error)
    })
    return write
  }
}

async function readIds(path: string): Promise<ReadonlySet<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    )
  } catch {
    return new Set()
  }
}
