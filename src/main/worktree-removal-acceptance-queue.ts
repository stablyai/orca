import { runKeyedSerializedOperation } from './cli/keyed-promise-queue'

const acceptanceQueueByRepo = new Map<string, Promise<void>>()

/** Serialize hooks/preflight/teardown per repo to avoid ref-lock races; checkout deletion runs separately. */
export function runSerializedWorktreeRemovalAcceptance<T>(
  repoPath: string,
  accept: () => Promise<T>
): Promise<T> {
  return runKeyedSerializedOperation(acceptanceQueueByRepo, repoPath, accept)
}
