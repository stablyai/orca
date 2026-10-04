import { runKeyedSerializedOperation } from './cli/keyed-promise-queue'

const acceptanceQueueByRepo = new Map<string, Promise<void>>()

/**
 * Runs one local removal's archive hook, preflight and teardown only after the previous removal in
 * the same repo was accepted, whichever client asked: hooks that write refs race the repo's ref
 * locks (#2259). Git's checkout delete runs after acceptance, in parallel under its own limit.
 */
export function runSerializedWorktreeRemovalAcceptance<T>(
  repoPath: string,
  accept: () => Promise<T>
): Promise<T> {
  return runKeyedSerializedOperation(acceptanceQueueByRepo, repoPath, accept)
}
