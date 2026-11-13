import { randomUUID } from 'node:crypto'
import type {
  AgentSenderAssociation,
  AgentSenderPublication,
  AgentSenderRevision
} from '../../../shared/agent-sender-associations'

export type AgentSenderScope = AgentSenderPublication & {
  associations: AgentSenderAssociation[]
  attachments: (AgentSenderAssociation & { homePeerFingerprint: string })[]
}
type Content = Omit<AgentSenderScope, 'revision'>

/** Field by field, as clients read them; key order and the revision stamp never count. */
function sameContent(
  a: Omit<AgentSenderPublication, 'revision'>,
  b: Omit<AgentSenderPublication, 'revision'>
): boolean {
  return (
    a.peerFingerprint === b.peerFingerprint &&
    JSON.stringify(a.principals) === JSON.stringify(b.principals) &&
    JSON.stringify(a.associations) === JSON.stringify(b.associations) &&
    JSON.stringify(a.attachments) === JSON.stringify(b.attachments)
  )
}

/** The host's one immutable sender publication and its worktree scopes. Its revision moves only
 *  when what clients read changes, so every delivery can say "unchanged" without the rows; the
 *  epoch is new for each runtime, so a replaced runtime is never mistaken for an older one. */
export class AgentSenderPublisher {
  constructor(private readonly ownsScope: (worktreeId: string) => boolean = () => false) {}
  readonly epoch = randomUUID()
  private revision = 0
  private publication: AgentSenderPublication = this.stamp({
    associations: [],
    principals: [],
    attachments: []
  })
  private scoped = new Map<string, AgentSenderScope>()
  private framed = new Map<string, AgentSenderPublication>()
  private contents = new Map<string, Content>()
  private empty = this.stamp({ ...this.hostFields(), associations: [], attachments: [] })

  current(): AgentSenderPublication {
    return this.publication
  }

  /** A worktree's scope keeps its object, and its revision, until its own content changes. */
  scope(worktreeId: string): AgentSenderPublication {
    let scoped = this.scoped.get(worktreeId)
    if (!scoped) {
      const content = this.contents.get(worktreeId)
      scoped = content ? this.stamp(content) : this.empty
      if (this.ownsScope(worktreeId) || content) {
        this.scoped.set(worktreeId, scoped)
      }
    }
    return scoped
  }

  retireScope(worktreeId: string): void {
    this.scoped.delete(worktreeId)
    this.framed.delete(worktreeId)
  }

  hasScope(worktreeId: string): boolean {
    return this.scoped.has(worktreeId) || this.contents.has(worktreeId)
  }

  frame(worktreeId: string): AgentSenderPublication {
    const scope = this.scope(worktreeId)
    if (!this.framed.has(worktreeId) && this.hasScope(worktreeId)) {
      this.framed.set(worktreeId, scope)
    }
    return scope
  }

  acknowledgeFrame(worktreeId: string, scope: AgentSenderPublication): void {
    if (this.hasScope(worktreeId)) {
      this.framed.set(worktreeId, scope)
    }
  }

  changedScopes(worktreeIds: Iterable<string>): string[] {
    return [...worktreeIds].filter(
      (id) => this.framed.has(id) && this.framed.get(id) !== this.scope(id)
    )
  }

  scopeCountsForTest() {
    return { scoped: this.scoped.size, framed: this.framed.size }
  }

  /** A window graph reply: the rows only when the window's applied base is not current. */
  forGraph(base: AgentSenderRevision | undefined): {
    agentSenderAssociations?: AgentSenderPublication
    agentSenderRevision?: AgentSenderRevision
  } {
    const current = this.publication.revision
    return base && current && base.epoch === current.epoch && base.revision === current.revision
      ? { agentSenderRevision: current }
      : { agentSenderAssociations: this.publication }
  }

  publish(next: Content): void {
    if (sameContent(next, this.publication)) {
      return
    }
    this.revision++
    this.publication = this.stamp(next)
    const host = this.hostFields()
    this.empty = this.stamp({ ...host, associations: [], attachments: [] })
    const scopes = new Map<string, Content>()
    const scopeOf = (worktreeId: string) => {
      let scope = scopes.get(worktreeId)
      if (!scope) {
        scope = { ...host, associations: [], attachments: [] }
        scopes.set(worktreeId, scope)
      }
      return scope
    }
    for (const row of next.associations) {
      scopeOf(row.worktreeId).associations.push(row)
    }
    for (const row of next.attachments) {
      scopeOf(row.worktreeId).attachments.push(row)
    }
    this.contents = new Map(scopes)
    for (const id of this.scoped.keys()) {
      if (this.contents.has(id) || this.ownsScope(id)) {
        scopeOf(id)
      } else {
        this.scoped.delete(id)
      }
    }
    for (const [id, scope] of scopes) {
      const previous = this.scoped.get(id)
      if (!previous || !sameContent(previous, scope)) {
        this.scoped.set(id, this.stamp(scope))
      }
    }
    for (const id of this.framed.keys()) {
      if (!this.hasScope(id)) {
        this.framed.delete(id)
      }
    }
  }

  private stamp<T extends Content>(content: T): T & { revision: AgentSenderRevision } {
    return { ...content, revision: { epoch: this.epoch, revision: this.revision } }
  }

  private hostFields() {
    const { principals, peerFingerprint } = this.publication
    return { principals, ...(peerFingerprint ? { peerFingerprint } : {}) }
  }
}

export function sameAgentSenderKey(key: unknown[], other: unknown[]): boolean {
  return key.length === other.length && key.every((value, i) => value === other[i])
}
