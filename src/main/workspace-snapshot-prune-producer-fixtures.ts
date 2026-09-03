import type { WorkspaceSnapshotPruneProducerToken } from './workspace-snapshot-prune-tombstone-holders'

type WithWorkspaceSnapshotPruneProducer = <T>(
  snapshotDirectory: string,
  produce: (producer: WorkspaceSnapshotPruneProducerToken) => Promise<T>
) => Promise<T>

export type OpenWorkspaceSnapshotPruneProducer = {
  producer: WorkspaceSnapshotPruneProducerToken
  /** Close the bracket and wait for the fence to settle. */
  finish: () => Promise<void>
}

/**
 * Hold a producer's fence open across test steps the way an in-flight scan holds it in production,
 * where the bracket spans a scan the test does not have.
 */
export async function openWorkspaceSnapshotPruneProducer(
  withProducer: WithWorkspaceSnapshotPruneProducer,
  snapshotDirectory: string
): Promise<OpenWorkspaceSnapshotPruneProducer> {
  let close = (): void => {}
  let announce = (_producer: WorkspaceSnapshotPruneProducerToken): void => {}
  const opened = new Promise<WorkspaceSnapshotPruneProducerToken>((resolve) => {
    announce = resolve
  })
  const bracket = withProducer(snapshotDirectory, async (producer) => {
    announce(producer)
    await new Promise<void>((resolve) => {
      close = resolve
    })
  })
  return {
    producer: await opened,
    finish: async () => {
      close()
      await bracket
    }
  }
}
