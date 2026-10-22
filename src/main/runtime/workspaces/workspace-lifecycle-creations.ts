import { randomUUID } from 'node:crypto'
import type {
  WorkspaceCreation,
  WorkspaceCreationsSnapshot
} from '../../../shared/sidebar-list/workspace-creations'
import type { ProducerRevision } from '../sidebar-inputs/producer-revision'
import type { LifecycleMembership } from './workspace-lifecycle-command'

export type WorkspaceCreationHandle = {
  /** The workspace is persisted; called before the host announces it. */
  named: (worktreeId: string) => void
  close: () => void
}

/** How a create holds its named workspace's queue while it runs. */
export type CreationQueuePort<Token> = {
  revision: ProducerRevision
  membership: () => LifecycleMembership
  deletePending: (key: string) => boolean
  bind: (key: string) => Token
  finish: (key: string, token: Token) => void
}

type Creation<Token> = WorkspaceCreation & {
  key?: string
  token?: Token
  settling?: boolean
  closed?: boolean
}

/** The creates in flight: listed from open, bound to the workspace's queue once named. */
export class WorkspaceLifecycleCreations<Token> {
  private readonly creations = new Map<string, Creation<Token>>()

  constructor(private readonly port: CreationQueuePort<Token>) {}

  /** Opened once the project is known; a caller without an id gets one, so a CLI create is listed. */
  open(start: {
    creationId?: string
    repoId: string
    /** The named workspace's queue key; commands sent to it then wait behind the create. */
    keyOf?: (worktreeId: string) => string
  }): WorkspaceCreationHandle {
    const { port } = this
    const creationId = start.creationId ?? randomUUID()
    const creation: Creation<Token> = { repoId: start.repoId }
    this.creations.set(creationId, creation)
    port.revision.bump()
    // Identity, not id: a concurrent retry under the same id owns the listing from then on.
    const owns = (): boolean => this.creations.get(creationId) === creation
    return {
      named: (worktreeId) => {
        if (creation.closed || !owns() || creation.worktreeId === worktreeId) {
          return
        }
        creation.worktreeId = worktreeId
        const key = start.keyOf?.(worktreeId)
        // Why not behind a delete: that delete is the previous occupant's, never this new one's.
        if (key && !creation.key && !port.deletePending(key)) {
          creation.key = key
          creation.token = port.bind(key)
        }
        port.revision.bump()
      },
      close: () => {
        if (creation.closed) {
          return
        }
        creation.closed = true
        // Its own queue entry always ends here, owned or not, so the workspace's queue moves on.
        if (creation.key && creation.token !== undefined) {
          port.finish(creation.key, creation.token)
        }
        if (!owns()) {
          return
        }
        const finish = (): void => {
          if (owns()) {
            this.creations.delete(creationId)
          }
          port.revision.bump()
        }
        if (creation.worktreeId === undefined) {
          finish()
          return
        }
        // Why held: the creation shows until a listing shows the workspace, in the same revision.
        creation.settling = true
        port.membership()(finish)
      }
    }
  }

  snapshot(): WorkspaceCreationsSnapshot {
    const creations: WorkspaceCreationsSnapshot['creations'] = {}
    for (const [creationId, { repoId, worktreeId }] of this.creations) {
      creations[creationId] = worktreeId === undefined ? { repoId } : { repoId, worktreeId }
    }
    return { revision: this.port.revision.value, creations }
  }

  /** Queue keys of finished creates still waiting for a listing to show them. */
  settlingKeys(): string[] {
    return [...this.creations.values()].flatMap(({ key, settling }) =>
      key && settling ? [key] : []
    )
  }
}
