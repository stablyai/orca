// GRANT-ID-TRACKING: the grant a pairing recovery left this computer holding for a sandbox that no
// binding tracks (an owned workspace's re-grant, or a paired one whose binding couldn't be updated).
// Kept on disk so the next recovery, even after a restart, revokes it instead of leaving a stray
// device grant on Orca Cloud. Grant ids aren't secrets; nothing else is stored.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FILE = 'cloud-recovery-grants.json'
const ID = /^[A-Za-z0-9_-]{1,128}$/

export function createCloudRecoveryGrantsStore(userDataPath: string) {
  const file = join(userDataPath, FILE)
  let writing: Promise<void> = Promise.resolve()

  async function read(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {}
      }
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] =>
            ID.test(entry[0]) && typeof entry[1] === 'string' && ID.test(entry[1])
        )
      )
    } catch {
      return {}
    }
  }

  return {
    async get(sandboxId: string): Promise<string | null> {
      await writing
      return (await read())[sandboxId] ?? null
    },
    /** Null forgets the sandbox's entry. Writes are serialized; a crash mid-write keeps the old file. */
    set(sandboxId: string, grantId: string | null): Promise<void> {
      writing = writing
        .catch(() => undefined)
        .then(async () => {
          const current = await read()
          if (grantId) {
            current[sandboxId] = grantId
          } else {
            delete current[sandboxId]
          }
          const temp = `${file}.${process.pid}.tmp`
          await writeFile(temp, JSON.stringify(current), { mode: 0o600 })
          await rename(temp, file)
        })
      return writing
    }
  }
}
