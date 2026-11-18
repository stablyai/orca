import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type { PtyProcessInspectionOptions } from '../../../providers/pty/process-inspection'
import type { PtyProcessInfo } from '../../../providers/pty/process-info'

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

  /** Targets with a route skip owner resolution; the router resolves any others apart. */
  listTargets(
    ids: readonly string[],
    opts: Parameters<IPtyProvider['listProcesses']>[0],
    router: Pick<IPtyProvider, 'listProcesses'>
  ): Promise<PtyProcessInfo[]> {
    return listRoutedTargetsApart(
      ids,
      (id) => this.routes.has(id),
      (routed) => this.listProcesses(routed, opts),
      (unrouted) => router.listProcesses({ ...opts, ptyIds: unrouted })
    )
  }

  /** An established target does not require a census of unrelated owners. */
  async listProcesses(ids: readonly string[], opts: Parameters<IPtyProvider['listProcesses']>[0]) {
    const targets = ids.map((id) => ({
      id,
      adapter: this.exactOwner(id),
      incarnation: this.incarnationFor(id)
    }))
    const idsByAdapter = new Map<DaemonPtyAdapter, string[]>()
    for (const target of targets) {
      const group = idsByAdapter.get(target.adapter) ?? []
      group.push(target.id)
      idsByAdapter.set(target.adapter, group)
    }
    const listed = await Promise.allSettled(
      [...idsByAdapter].map(([adapter, ptyIds]) => adapter.listProcesses({ ...opts, ptyIds }))
    )
    const rows = listedOwnerRows(listed)
    // A missing, re-routed or replaced target is absent here; the caller reads that as unknown, never as exit.
    const targetsById = new Map(targets.map((target) => [target.id, target]))
    return rows.filter((row) => {
      const target = targetsById.get(row.id)
      return (
        target &&
        // Why the route, not exactOwner: a target that exited meanwhile throws there and would sink the rest.
        this.routes.get(target.id) === target.adapter &&
        this.incarnationFor(target.id) === target.incarnation &&
        (!target.incarnation || row.incarnationId === target.incarnation)
      )
    })
  }
}

/** Rows from every owner that answered: one failing owner costs only its own targets their rows,
 *  and the read fails only when no owner answered. */
export function listedOwnerRows<Row>(
  listed: readonly PromiseSettledResult<readonly Row[]>[]
): Row[] {
  const rejected = listed.find((result) => result.status === 'rejected')
  if (rejected && listed.every((result) => result.status === 'rejected')) {
    throw rejected.reason
  }
  return listed.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
}

/** Routed targets take their owners' path and the rest resolve apart, so either side failing
 *  costs only its own targets their rows. */
export async function listRoutedTargetsApart<Row>(
  ids: readonly string[],
  isRouted: (id: string) => boolean,
  listRouted: (ids: readonly string[]) => Promise<readonly Row[]>,
  listUnrouted: (ids: readonly string[]) => Promise<readonly Row[]>
): Promise<Row[]> {
  const routed = ids.filter(isRouted)
  if (routed.length === ids.length) {
    return [...(await listRouted(routed))]
  }
  const unrouted = ids.filter((id) => !isRouted(id))
  return listedOwnerRows(await Promise.allSettled([listRouted(routed), listUnrouted(unrouted)]))
}
