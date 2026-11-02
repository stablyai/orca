import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import { waitForTerminalAttachOperation } from './terminal-attach-cancellation'
import type { PtyCreationDisposition } from '../../shared/claimed-agent-pty-owner'
import type { TerminalSpawnGate, TerminalSpawnLease } from './terminal-spawn-gate'

export type PendingTerminalCreation = {
  completion: Promise<void>
  recover: () => Promise<void>
}

/** The complete ordinary call owns every lower attempt and acquired dependency. */
export class TerminalCreationWork {
  private readonly result = Promise.withResolvers<PtyCreationDisposition>()
  readonly completion = this.result.promise
  private readonly dependencies: Promise<PtyCreationDisposition>[] = []
  private readonly owners: {
    completion: Promise<void>
    exitCode: () => number | null
    recover?: () => Promise<void>
  }[] = []
  private uncertain = false

  physicalObserver(
    report: ((completion: Promise<void>, exitCode: () => number | null) => void) | undefined
  ): (completion: Promise<void>, exitCode: () => number | null) => void {
    return (completion, exitCode) => {
      this.owner(completion, exitCode)
      report?.(completion, exitCode)
    }
  }

  join(disposition: Promise<PtyCreationDisposition>): void {
    this.dependencies.push(disposition)
  }

  dispatched(): void {
    this.uncertain = true
  }

  owner(
    completion: Promise<void>,
    exitCode: () => number | null,
    recover?: () => Promise<void>
  ): void {
    this.owners.push({ completion, exitCode, recover })
  }

  async finish(reconcile?: (release: () => Promise<void>) => Promise<void>): Promise<void> {
    const joined = await Promise.all(this.dependencies)
    const physical = [
      ...this.owners,
      ...joined.flatMap((entry) => (entry.kind === 'physical' ? [entry] : []))
    ]
    const release = async () => {
      await Promise.all(
        [...this.owners, ...joined.filter((entry) => entry.kind !== 'no-fork')].map(async (entry) =>
          entry.recover?.()
        )
      )
    }
    let recovery: Promise<void> | undefined
    const recover = () => {
      recovery ??= (reconcile ? reconcile(release) : release()).finally(() => {
        recovery = undefined
      })
      return recovery
    }
    if (this.uncertain || joined.some((entry) => entry.kind === 'unknown')) {
      this.result.resolve({ kind: 'unknown', recover })
    } else if (joined.some((entry) => entry.kind === 'failed')) {
      this.result.resolve({
        kind: 'failed',
        completion: Promise.all([
          ...physical.map((entry) => entry.completion),
          ...joined.flatMap((entry) => (entry.kind === 'failed' ? [entry.completion] : []))
        ]).then(() => {}),
        recover
      })
    } else if (physical.length) {
      this.result.resolve({
        kind: 'physical',
        completion: Promise.all(physical.map((entry) => entry.completion)).then(() => {}),
        exitCode: () => physical.at(-1)?.exitCode() ?? null,
        recover
      })
    } else {
      this.result.resolve({ kind: 'no-fork' })
    }
  }
}

export function reconcileUnpublishedTerminalCreation(
  sessions: ReadonlyMap<string, unknown>,
  sessionId: string
): (release: () => Promise<void>) => Promise<void> {
  return async (release) => {
    // Registered Sessions retain their ordinary current/use-fenced close authority.
    if (!sessions.has(sessionId)) {
      await release()
    }
  }
}

/** Keep pending recovery and exact-entry retirement outside the completed request's scope. */
export function registerPendingTerminalCreation(
  pendingCreations: Map<string, PendingTerminalCreation>,
  sessionId: string,
  creation: TerminalCreationWork
): (published: boolean) => void {
  const settled = Promise.withResolvers<void>()
  const pending: PendingTerminalCreation = {
    completion: settled.promise,
    recover: async () => {
      const disposition = await creation.completion
      if (disposition.kind !== 'no-fork') {
        await disposition.recover?.()
      }
    }
  }
  pendingCreations.set(sessionId, pending)
  const finish = () => {
    if (pendingCreations.get(sessionId) === pending) {
      pendingCreations.delete(sessionId)
    }
    settled.resolve()
  }
  return (published) => {
    if (published) {
      finish()
    } else {
      void creation.completion.then(async (disposition) => {
        if (disposition.kind === 'unknown') {
          return
        }
        if (disposition.kind === 'physical' || disposition.kind === 'failed') {
          await disposition.completion
        }
        finish()
      })
    }
  }
}

/** An unpublished attempt keeps its existing lease until its actual disposition permits release. */
export function settleUnpublishedTerminalSpawnLease(
  completion: Promise<PtyCreationDisposition>,
  admitted: TerminalSpawnLease | undefined,
  sessionId: string,
  spawnGate: TerminalSpawnGate | undefined
): void {
  void completion.then(async (disposition) => {
    if (disposition.kind === 'no-fork') {
      admitted?.abandon()
    } else if (disposition.kind === 'failed') {
      await disposition.completion
      admitted?.abandon()
    } else if (disposition.kind === 'physical') {
      admitted?.commit(sessionId, true)
      await disposition.completion
      spawnGate?.onSessionExit(sessionId)
    }
  })
}

/** Recovery may outlive the observer; its rejection observer needs only the actual outcome. */
export function recoverUnpublishedTerminalCreation(disposition: PtyCreationDisposition): void {
  if (disposition.kind !== 'no-fork') {
    void disposition.recover?.().catch(() => {})
  }
}

export async function runTerminalCreation<Result>(
  opts: InternalCreateOrAttachOptions,
  sessions: ReadonlyMap<string, unknown>,
  pendingCreations: Map<string, PendingTerminalCreation>,
  assertCreateAllowed: (options: InternalCreateOrAttachOptions) => void,
  operation: (
    options: InternalCreateOrAttachOptions,
    creation: TerminalCreationWork
  ) => Promise<Result>
): Promise<Result> {
  const creation = new TerminalCreationWork()
  const requestedOptions = opts
  opts = {
    ...opts,
    creationWork: creation,
    onPhysicalOwner: creation.physicalObserver(opts.onPhysicalOwner)
  }
  try {
    assertCreateAllowed(opts)
    for (
      let inFlight = pendingCreations.get(opts.sessionId);
      inFlight !== undefined;
      inFlight = pendingCreations.get(opts.sessionId)
    ) {
      // Let canceled callers leave rather than wait behind a cwd probe stuck on an unreachable share.
      const pending = inFlight
      await waitForTerminalAttachOperation(
        pending.recover().then(() => pending.completion),
        opts.cancelSignal,
        opts.sessionId
      )
      assertCreateAllowed(opts)
    }
    assertCreateAllowed(opts)

    const finishPending = registerPendingTerminalCreation(
      pendingCreations,
      opts.sessionId,
      creation
    )
    let published = false
    try {
      const result = await operation(opts, creation)
      published = true
      return result
    } finally {
      finishPending(published || sessions.has(opts.sessionId))
    }
  } finally {
    await creation.finish(reconcileUnpublishedTerminalCreation(sessions, opts.sessionId))
    const disposition = await creation.completion
    requestedOptions.onCreationDisposition?.(disposition)
    if (!sessions.has(opts.sessionId) && disposition.kind !== 'no-fork') {
      // Failed unpublished resources keep the same ordinary cleanup owner across Retry/disposal.
      recoverUnpublishedTerminalCreation(disposition)
    }
  }
}
