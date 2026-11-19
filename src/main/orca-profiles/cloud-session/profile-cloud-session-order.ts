import { inCredentialFileOrder } from '../../credentials/credential-file-io'
import { getOrcaCloudSessionPath } from './profile-cloud-session-store'

export const pendingChanges = new Set<Promise<unknown>>()

export function inCloudSessionOrder<T>(
  profileId: string,
  userDataPath: string,
  run: () => Promise<T>
): Promise<T> {
  const next = inCredentialFileOrder(
    `${getOrcaCloudSessionPath(profileId, userDataPath)}.owner`,
    run
  )
  pendingChanges.add(next)
  void next.then(
    () => pendingChanges.delete(next),
    () => pendingChanges.delete(next)
  )
  return next
}
