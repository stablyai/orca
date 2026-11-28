import { readEnvironmentStoreRecords } from '../../../../shared/remote-runtime/host-store/runtime-environment-registry'

/** Every server id still saved, including newer-format and overlay-hidden ones; null when the
 *  registry can't prove which servers were removed, so callers must not clean anything up. */
export async function readSavedRuntimeEnvironmentIds(
  userDataPath: string
): Promise<Set<string> | null> {
  try {
    // Raw records, not the listing: newer-format and overlay-hidden servers are still saved.
    const records = await readEnvironmentStoreRecords(userDataPath, { requireStoreFile: true })
    if (records.unreadable.some((record) => record.id === undefined)) {
      return null
    }
    return new Set([
      ...records.environments.map((environment) => environment.id),
      ...records.unreadable.map((record) => record.id ?? '')
    ])
  } catch {
    // Missing or unreadable registry data cannot prove a server was removed.
    return null
  }
}
