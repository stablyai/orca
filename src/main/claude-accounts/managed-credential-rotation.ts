import { readAccessToken, readRefreshToken } from './oauth-refresh'

const rotations = new Map<string, Promise<unknown>>()

/** Whether managed storage now holds a different access or refresh token. */
export function storedOauthCredentialDiffers(stored: string, snapshot: string): boolean {
  const storedRefresh = readRefreshToken(stored)
  const snapshotRefresh = readRefreshToken(snapshot)
  const storedAccess = readAccessToken(stored)
  const snapshotAccess = readAccessToken(snapshot)
  return (
    (storedRefresh !== null && storedRefresh !== snapshotRefresh) ||
    (storedAccess !== null && storedAccess !== snapshotAccess)
  )
}

/**
 * One in-flight rotation for a single saved Claude login.
 *
 * Account selection refreshes inside its mutation queue. An inactive usage
 * preview can refresh the same single-use token while that selection is
 * reading it. Sharing this queue makes the second caller re-read the blob
 * the first caller already persisted. A different login does not wait.
 */
export function withClaudeManagedCredentialRotation<T>(
  accountId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = rotations.get(accountId) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  rotations.set(accountId, settled)
  void settled.then(() => {
    if (rotations.get(accountId) === settled) {
      rotations.delete(accountId)
    }
  })
  return run
}
