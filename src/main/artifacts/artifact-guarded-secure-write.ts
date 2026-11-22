import { writeSecureFileAsync } from '../../shared/secure-storage/secure-file-async-write'

const ACCOUNT_CHANGED = 'The signed-in Orca account changed while the artifact request was running.'

/** Write a secure file only while `assertCurrent` passes: before the rename, after a durable write
 *  has waited for the disk, and once more when the write resolves, so a caller acting on the write
 *  (sending a create request) never runs for an account that signed out meanwhile. */
export async function writeArtifactFileWhileCurrent(
  path: string,
  contents: string,
  durable: boolean,
  assertCurrent: () => void,
  /** Re-check once the write resolves, for callers that act on it next (sending a request). */
  recheckAfterWrite: boolean,
  /** Runs synchronously with the rename, before anything else can read the published file. */
  onPublished?: () => void
): Promise<void> {
  let published = false
  const options = {
    shouldPublish: () => {
      try {
        assertCurrent()
        return true
      } catch {
        return false
      }
    },
    onPublished: () => {
      published = true
      onPublished?.()
    }
  }
  try {
    await writeSecureFileAsync(path, contents, { ...options, durable })
  } catch (error) {
    // A sign-out clears staged files too; report the account change, not the vanished file.
    assertCurrent()
    throw error
  }
  if (!published) {
    throw new Error(ACCOUNT_CHANGED)
  }
  if (recheckAfterWrite) {
    assertCurrent()
  }
}

const changesByPath = new Map<string, Promise<void>>()

/** Run read-modify-write changes to one file or folder in order, so a change waiting on the disk
 *  never lets another read, sweep or replace what it is about to publish. */
export function serializeArtifactFileChange<T>(path: string, run: () => Promise<T>): Promise<T> {
  const next = (changesByPath.get(path) ?? Promise.resolve()).then(run)
  const settled = next.then(
    () => {},
    () => {}
  )
  changesByPath.set(path, settled)
  void settled.then(() => {
    if (changesByPath.get(path) === settled) {
      changesByPath.delete(path)
    }
  })
  return next
}
