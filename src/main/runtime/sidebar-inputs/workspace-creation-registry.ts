import { ProducerRevision } from './producer-revision'
import { randomUUID } from 'node:crypto'
import type {
  WorkspaceCreation,
  WorkspaceCreationsSnapshot
} from '../../../shared/sidebar-list/workspace-creations'

/** One listed creation, owned by the create that opened it. */
export type WorkspaceCreationHandle = {
  /** The workspace is persisted; called before the host announces it. */
  named: (worktreeId: string) => void
  close: () => void
}

/** Every creation this host is running, whoever asked: its own window, a phone, the CLI. */
export class WorkspaceCreationRegistry {
  private readonly creations = new Map<string, WorkspaceCreation>()
  readonly revision = new ProducerRevision()

  /** Opened once the project is known. A caller without an id gets one, so a CLI create is listed. */
  open(start: { creationId?: string; repoId: string }): WorkspaceCreationHandle {
    const creationId = start.creationId ?? randomUUID()
    const entry: WorkspaceCreation = { repoId: start.repoId }
    this.creations.set(creationId, entry)
    this.revision.bump()
    // Identity, not id: a concurrent retry under the same id owns the entry from then on.
    const owns = (): boolean => this.creations.get(creationId) === entry
    return {
      named: (worktreeId) => {
        if (owns() && entry.worktreeId !== worktreeId) {
          entry.worktreeId = worktreeId
          this.revision.bump()
        }
      },
      close: () => {
        if (owns()) {
          this.creations.delete(creationId)
          this.revision.bump()
        }
      }
    }
  }

  snapshot(): WorkspaceCreationsSnapshot {
    const creations: WorkspaceCreationsSnapshot['creations'] = {}
    for (const [creationId, entry] of this.creations) {
      creations[creationId] = { ...entry }
    }
    return { revision: this.revision.value, creations }
  }
}
