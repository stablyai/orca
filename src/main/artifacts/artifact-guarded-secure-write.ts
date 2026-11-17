import { writeDurableSecureFile, writeSecureFile } from '../../shared/secure-storage/secure-file'

const ACCOUNT_CHANGED = 'The signed-in Orca account changed while the artifact request was running.'

/** Write a secure file only while `assertCurrent` passes: it is checked again right before the
 *  rename, after a durable write has waited for the disk, so a sign-out in between drops it. */
export async function writeArtifactFileWhileCurrent(
  path: string,
  contents: string,
  durable: boolean,
  assertCurrent: () => void
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
    }
  }
  if (durable) {
    await writeDurableSecureFile(path, contents, options)
  } else {
    writeSecureFile(path, contents, options)
  }
  if (!published) {
    assertCurrent()
    throw new Error(ACCOUNT_CHANGED)
  }
}

const changesByPath = new Map<string, Promise<void>>()

/** Run read-modify-write changes to one file in order, so a change waiting on the disk never
 *  lets another read the file it is about to replace. */
export function serializeArtifactFileChange(path: string, run: () => Promise<void>): Promise<void> {
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
