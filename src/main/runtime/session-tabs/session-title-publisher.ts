import { OrcaRuntimeWithStopTerminalsForProject } from '../terminal/stop/project-terminal-stop'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'

export type SessionTitlePublisher = {
  windowId: number
  rendererGeneration: string
  surfaceIds: ReadonlySet<string>
}

export type SessionTitleAuthority = ReadonlyMap<string, ReadonlySet<string>>

export abstract class OrcaRuntimeWithSessionTitleAuthority extends OrcaRuntimeWithStopTerminalsForProject {
  private currentSessionTitlePublisher(worktreeId: string): SessionTitlePublisher | undefined {
    const publisher = this.acceptedRendererMobileSnapshotByWorktree.get(worktreeId)?.titlePublisher
    return (
      (publisher &&
        this.graphStatus === 'ready' &&
        publisher.windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
        publisher.windowId === this.authoritativeWindowId &&
        publisher.rendererGeneration === this.rendererGeneration &&
        publisher) ||
      undefined
    )
  }

  protected isSessionTitlePublisher(worktreeId: string, surfaceId: string): boolean {
    return !!(
      this.getAvailableAuthoritativeWindow() &&
      this.currentSessionTitlePublisher(worktreeId)?.surfaceIds.has(surfaceId)
    )
  }

  protected captureSessionTitleAuthority(): SessionTitleAuthority {
    const authority = new Map<string, ReadonlySet<string>>()
    for (const worktreeId of this.acceptedRendererMobileSnapshotByWorktree.keys()) {
      // The close callback can run after the OS window is gone; ready still names its last publication.
      const ids = this.currentSessionTitlePublisher(worktreeId)?.surfaceIds
      if (ids?.size) {
        authority.set(worktreeId, ids)
      }
    }
    return authority
  }

  protected republishSessionTitleAuthorityChanges(
    before: SessionTitleAuthority,
    alreadyChanged: ReadonlySet<string> = new Set()
  ): void {
    const after = this.captureSessionTitleAuthority()
    for (const worktreeId of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(worktreeId)
      const next = after.get(worktreeId)
      if (
        !alreadyChanged.has(worktreeId) &&
        (previous?.size !== next?.size || (previous && [...previous].some((id) => !next?.has(id))))
      ) {
        // Retained rows can stay identical while their publisher stops resolving titles.
        this.touchMobileSessionTabsForWorktree(worktreeId)
      }
    }
  }
}
