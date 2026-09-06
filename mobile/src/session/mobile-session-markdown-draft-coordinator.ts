import type {
  HostSessionMarkdownDraft,
  HostSessionMarkdownOperations,
  HostSessionMarkdownTarget
} from './host-session-markdown-operations'
import type { MarkdownDocState } from './mobile-session-route-types'

type ObservedDraft = HostSessionMarkdownDraft | null
type ReadyMarkdownDoc = Extract<MarkdownDocState, { status: 'ready' }>

export class MobileSessionMarkdownDraftCoordinator {
  private generation = 0
  private readonly hydrated = new Set<string>()
  private readonly hydrationPending = new Set<string>()
  private readonly editVersion = new Map<string, number>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingDrafts = new Map<string, ObservedDraft>()
  private readonly pendingTargets = new Map<string, HostSessionMarkdownTarget>()
  private readonly lastObserved = new Map<string, ObservedDraft>()
  private readonly writeTails = new Map<string, Promise<void>>()

  constructor(
    private readonly operations: HostSessionMarkdownOperations,
    private readonly debounceMs = 250
  ) {}

  isHydrated(target: HostSessionMarkdownTarget): boolean {
    return this.hydrated.has(targetKey(target))
  }

  markEdited(target: HostSessionMarkdownTarget): void {
    const key = targetKey(target)
    this.hydrated.add(key)
    this.editVersion.set(key, (this.editVersion.get(key) ?? 0) + 1)
  }

  async hydrate(
    target: HostSessionMarkdownTarget,
    apply: (draft: HostSessionMarkdownDraft) => void
  ): Promise<void> {
    const key = targetKey(target)
    if (this.hydrated.has(key) || this.hydrationPending.has(key)) {
      return
    }
    this.hydrationPending.add(key)
    const generation = this.generation
    const editVersion = this.editVersion.get(key) ?? 0
    try {
      const draft = await this.operations.loadDraft(target)
      if (
        generation === this.generation &&
        (this.editVersion.get(key) ?? 0) === editVersion &&
        draft
      ) {
        apply(draft)
      }
    } finally {
      if (generation === this.generation) {
        this.hydrated.add(key)
      }
      this.hydrationPending.delete(key)
    }
  }

  scheduleSave(target: HostSessionMarkdownTarget, draft: ObservedDraft): void {
    const key = targetKey(target)
    if (!this.hydrated.has(key) || draftsEqual(this.lastObserved.get(key), draft)) {
      return
    }
    this.lastObserved.set(key, draft)
    this.pendingDrafts.set(key, draft)
    this.pendingTargets.set(key, target)
    this.cancelTimer(key)
    this.timers.set(
      key,
      setTimeout(
        () => {
          this.timers.delete(key)
          const pending = this.pendingDrafts.get(key)
          this.pendingDrafts.delete(key)
          this.pendingTargets.delete(key)
          if (pending !== undefined) {
            void this.enqueue(target, pending)
          }
        },
        draft ? this.debounceMs : 0
      )
    )
  }

  async clear(target: HostSessionMarkdownTarget): Promise<void> {
    const key = targetKey(target)
    this.hydrated.add(key)
    this.editVersion.set(key, (this.editVersion.get(key) ?? 0) + 1)
    this.cancelTimer(key)
    this.pendingDrafts.delete(key)
    this.pendingTargets.delete(key)
    this.lastObserved.set(key, null)
    await this.enqueue(target, null)
  }

  dispose(): void {
    this.generation += 1
    for (const [key, timer] of this.timers) {
      clearTimeout(timer)
      this.timers.delete(key)
      const target = this.pendingTargets.get(key)
      const draft = this.pendingDrafts.get(key)
      if (target && draft !== undefined) {
        void this.enqueue(target, draft)
      }
    }
    this.pendingDrafts.clear()
    this.pendingTargets.clear()
    this.hydrated.clear()
    this.hydrationPending.clear()
  }

  private async enqueue(target: HostSessionMarkdownTarget, draft: ObservedDraft): Promise<void> {
    const key = targetKey(target)
    const previous = this.writeTails.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.operations.saveDraft(target, draft))
    this.writeTails.set(key, next)
    try {
      await next
    } finally {
      if (this.writeTails.get(key) === next) {
        this.writeTails.delete(key)
      }
    }
  }

  private cancelTimer(key: string): void {
    const timer = this.timers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
  }
}

export function restoreMobileSessionMarkdownDraft(
  document: ReadyMarkdownDoc,
  draft: HostSessionMarkdownDraft
): ReadyMarkdownDoc {
  const versionChanged = draft.baseVersion !== document.baseVersion
  return {
    ...document,
    localContent: draft.content,
    baseVersion: draft.baseVersion,
    isDirty: draft.content !== document.content || versionChanged,
    stale: document.stale === true || versionChanged
  }
}

function targetKey(target: HostSessionMarkdownTarget): string {
  return JSON.stringify([target.workspaceId, target.tabId, target.relativePath])
}

function draftsEqual(left: ObservedDraft | undefined, right: ObservedDraft): boolean {
  return (
    left !== undefined &&
    (left === right ||
      (left !== null &&
        right !== null &&
        left.content === right.content &&
        left.baseVersion === right.baseVersion))
  )
}
