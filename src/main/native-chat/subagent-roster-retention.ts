import { BoundedMap } from '../../shared/bounded-map'
import { isTerminalSubagentState } from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'

type RetainedRosterGroup = {
  groupId: string
  lastSerialized: string | null
}

/** Bounds settled history; live children and refused final writes keep their ownership. */
export class SubagentRosterRetention<Group extends RetainedRosterGroup> {
  private readonly settledGroups = new Set<string>()
  private readonly settledIdentities: BoundedMap<string, true>

  constructor(
    private readonly groups: Map<string, Group>,
    private readonly options: {
      maxGroups: number
      maxSettledIdentities: number
      entries: (group: Group) => Iterable<NativeChatSubagentEntry>
      identities: (group: Group) => Iterable<string>
      onEvict?: (group: Group) => void
    }
  ) {
    this.settledIdentities = new BoundedMap({ maxEntries: options.maxSettledIdentities })
  }

  hasSettled(identity: string): boolean {
    return this.settledIdentities.has(identity)
  }

  /** Superseded executions share the evicted history's single bounded budget. */
  rememberSettled(identity: string): void {
    this.settledIdentities.set(identity, true)
  }

  trim(changed: Iterable<Group>, retainedGroupId?: string): void {
    for (const group of changed) {
      if (
        group.lastSerialized !== null &&
        [...this.options.entries(group)].every((entry) => isTerminalSubagentState(entry.state))
      ) {
        this.settledGroups.add(group.groupId)
      } else {
        this.settledGroups.delete(group.groupId)
      }
    }
    for (const groupId of this.settledGroups) {
      if (this.groups.size <= this.options.maxGroups) {
        break
      }
      if (groupId === retainedGroupId) {
        continue
      }
      const group = this.groups.get(groupId)
      if (group) {
        for (const identity of this.options.identities(group)) {
          this.rememberSettled(identity)
        }
        this.options.onEvict?.(group)
      }
      this.groups.delete(groupId)
      this.settledGroups.delete(groupId)
    }
  }

  sizes(): { groups: number; settledIdentities: number } {
    return { groups: this.groups.size, settledIdentities: this.settledIdentities.size }
  }

  clear(): void {
    this.settledGroups.clear()
    this.settledIdentities.clear()
  }
}
