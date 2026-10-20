// The tab group each workspace shows, as the window last reported it: a view fact, kept in memory
// only. Main opens a CLI or phone file there; with no window, in the last group it was told. A
// removed workspace's entry stays: a stale group is refused and the open falls back to main's rule.

export class ActiveGroupViewFacts {
  /** Workspace key → the group the window shows; null when it shows none. */
  private readonly reported = new Map<string, string | null>()

  /** A window's report: each named workspace's entry replaces the last; others are kept. */
  merge(report: Readonly<Record<string, string | null>> | undefined): void {
    for (const [workspace, groupId] of Object.entries(report ?? {})) {
      this.reported.set(workspace, groupId)
    }
  }

  /** The reported group, else the saved view's (after a restart no window has reported yet). */
  groupFor(workspace: string, savedGroupId: () => string | null | undefined): string | undefined {
    const groupId = this.reported.has(workspace) ? this.reported.get(workspace) : savedGroupId()
    return groupId ?? undefined
  }
}
