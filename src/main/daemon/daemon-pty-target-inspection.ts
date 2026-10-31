import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { PtyProcessInspectionOptions } from '../providers/pty-process-inspection'

/** Foreground reads go to the exact owner and never borrow the current daemon's default route. */
export class DaemonPtyTargetInspection {
  constructor(
    private readonly adapters: () => readonly DaemonPtyAdapter[],
    private readonly routes: Map<string, DaemonPtyAdapter>,
    private readonly incarnationFor: (id: string) => string | undefined
  ) {}

  private exactOwner(id: string, remember = true): DaemonPtyAdapter {
    const established = this.routes.get(id)
    const candidates = established
      ? [established]
      : this.adapters().filter((adapter) => adapter.hasPty(id))
    const adapter = candidates.length === 1 ? candidates[0] : undefined
    if (!adapter) {
      throw new Error('terminal_gone')
    }
    if (remember) {
      this.routes.set(id, adapter)
    }
    return adapter
  }

  private firstOwner(id: string): DaemonPtyAdapter {
    const adapter = this.routes.get(id) ?? this.adapters().find((c) => c.hasPty(id))
    if (!adapter) {
      throw new Error('terminal_gone')
    }
    this.routes.set(id, adapter)
    return adapter
  }

  supportsForegroundObservation(id: string): boolean {
    try {
      return this.exactOwner(id, false).supportsForegroundObservation?.(id) === true
    } catch {
      return false
    }
  }

  async inspectProcess(id: string, options: PtyProcessInspectionOptions | undefined) {
    if (options?.foregroundOnly !== true) {
      return this.firstOwner(id).inspectProcess(id, options)
    }
    const adapter = this.exactOwner(id)
    const incarnation = this.incarnationFor(id)
    const result = await adapter.inspectProcess(id, options)
    if (this.exactOwner(id) !== adapter || this.incarnationFor(id) !== incarnation) {
      throw new Error('terminal_handle_stale')
    }
    return result
  }

  /** An established target does not require a census of unrelated owners. */
  async listProcesses(ids: readonly string[], opts: Parameters<IPtyProvider['listProcesses']>[0]) {
    const targets = ids.map((id) => ({
      id,
      adapter: this.exactOwner(id),
      incarnation: this.incarnationFor(id)
    }))
    const groups = new Set(targets.map((target) => target.adapter))
    const rows = (
      await Promise.all(
        [...groups].map((adapter) =>
          adapter.listProcesses({
            ...opts,
            ptyIds: targets
              .filter((target) => target.adapter === adapter)
              .map((target) => target.id)
          })
        )
      )
    ).flat()
    for (const target of targets) {
      if (
        this.exactOwner(target.id) !== target.adapter ||
        this.incarnationFor(target.id) !== target.incarnation
      ) {
        throw new Error('terminal_handle_stale')
      }
    }
    // A missing or replaced row is absent here; the caller reads that as unknown, never as exit.
    return rows.filter((row) => {
      const target = targets.find((candidate) => candidate.id === row.id)
      return target && (!target.incarnation || row.incarnationId === target.incarnation)
    })
  }
}
