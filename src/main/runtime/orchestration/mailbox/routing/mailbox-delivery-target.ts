import { mergeDeferredReservedTypes } from '../terminal-pointer/mailbox-pointer-state'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { OrchestrationMailboxTerminal } from './mailbox-owner'

export type ForegroundShellProbe = {
  incarnationId: string | null
  read: () => Promise<boolean>
}

type ReservedTypes = ReadonlySet<string> | undefined

// Each mailbox keeps the types another path owns, so redelivery doesn't type them.
type ProbeDeferral = {
  mailboxes: Map<string, ReservedTypes>
  started: boolean
  joinedInFlight: boolean
  /** This read was forced by joiners; its own joiners don't force another, so a stream of deliveries can't loop. */
  forced: boolean
}

type OrchestrationMailboxDeliveryTargetDependencies = {
  getDb: () => OrchestrationDb | null
  /** The terminal now in the pane, keyed by its PTY, so a replaced or unlisted PTY is still reached. */
  getMailboxTerminalForPaneKey: (paneKey: string) => OrchestrationMailboxTerminal | null
  getTerminalForHandle: (handle: string) => OrchestrationMailboxTerminal | null
  hasTerminalHandle: (handle: string) => boolean
  /** A structured worker or a chat has no PTY handle; its own lane delivers, so this must not claim it. */
  isStructuredSessionOwner: (handle: string) => boolean
  canProbePtyLiveness: () => boolean
  controllerKnowsPtyIsLive: (ptyId: string) => boolean
  isLeafPtyProvenAbsent: (ptyId: string) => Promise<boolean>
  /** The pane's agent process incarnation and a read of whether a shell, not it, is in front;
   *  null when the pane names no agent or the host can't read its foreground per terminal. */
  foregroundShellProbe: (ptyId: string) => ForegroundShellProbe | null
}

export class OrchestrationMailboxDeliveryTarget {
  private readonly probeDeferrals = new Map<string, ProbeDeferral>()
  private readonly forcedRereads = new Set<string>()

  constructor(private readonly deps: OrchestrationMailboxDeliveryTargetDependencies) {}

  resolveTerminal(handle: string): OrchestrationMailboxTerminal | null {
    if (this.deps.hasTerminalHandle(handle)) {
      return this.deps.getTerminalForHandle(handle)
    }
    if (this.deps.isStructuredSessionOwner(handle)) {
      return null
    }
    const { paneKey, ownerHandle } = this.roleMailboxOwner(handle)
    const paneTerminal = paneKey ? this.deps.getMailboxTerminalForPaneKey(paneKey) : null
    if (paneTerminal) {
      return paneTerminal
    }
    if (!ownerHandle) {
      return null
    }
    if (this.deps.isStructuredSessionOwner(ownerHandle)) {
      return null
    }
    if (!this.deps.hasTerminalHandle(ownerHandle)) {
      // Log unresolved owners: silent null looks identical to no mail and hides lost routing.
      console.warn('[orchestration] mailbox owner resolved to an unknown terminal', {
        mailboxHandle: handle,
        ownerHandle
      })
      return null
    }
    return this.deps.getTerminalForHandle(ownerHandle)
  }

  /** Whether mail to the handle reaches a terminal open here, directly or through its owner's pane. */
  reachesOpenTerminal(handle: string): boolean {
    if (this.deps.hasTerminalHandle(handle)) {
      return true
    }
    const { paneKey, ownerHandle } = this.roleMailboxOwner(handle)
    if (paneKey && this.deps.getMailboxTerminalForPaneKey(paneKey)) {
      return true
    }
    return Boolean(ownerHandle && this.deps.hasTerminalHandle(ownerHandle))
  }

  private roleMailboxOwner(handle: string): {
    paneKey: string | null | undefined
    ownerHandle: string | null | undefined
  } {
    const db = this.deps.getDb()
    const runId = handle.startsWith('run:') ? handle.slice('run:'.length) : ''
    const dispatchId = handle.startsWith('dispatch:') ? handle.slice('dispatch:'.length) : ''
    const dispatch = dispatchId ? db?.getDispatchContextById?.(dispatchId) : undefined
    const remote =
      dispatchId && !dispatch ? db?.getRemoteDispatchAttachment?.(dispatchId) : undefined
    const run = runId ? db?.getRun(runId) : undefined
    // Runs bind their coordinator by pane; the stored handle is stale once that pane's PTY is replaced.
    return run
      ? { paneKey: run.coordinator_pane_key, ownerHandle: run.coordinator_handle }
      : {
          paneKey: dispatch?.assignee_pane_key ?? remote?.pane_key,
          ownerHandle: dispatch?.assignee_handle ?? remote?.terminal_handle
        }
  }

  /** Type only after async proof that the PTY exists and its agent, not a shell, is in front:
   *  the agent's status outlives its exit, so mail would run in the shell it left.
   *  `redeliver(mailbox, reprobe, reservedTypes)` types at once, or probes again when the proof went stale. */
  deferForTerminalProbe(
    ptyId: string,
    mailboxHandle: string,
    skipProbe: boolean | undefined,
    redeliver: (mailboxHandle: string, reprobe: boolean, reservedTypes: ReservedTypes) => void,
    reservedTypes?: ReadonlySet<string>
  ): boolean {
    if (skipProbe) {
      return false
    }
    const probeAbsence =
      this.deps.canProbePtyLiveness() && !this.deps.controllerKnowsPtyIsLive(ptyId)
    const probeShell = this.deps.foregroundShellProbe(ptyId)
    if (!probeAbsence && !probeShell) {
      return false
    }
    // A coordinator of several Runs can defer one mailbox per Run on the same probe.
    const inFlight = this.probeDeferrals.get(ptyId)
    if (inFlight) {
      inFlight.mailboxes.set(
        mailboxHandle,
        mergeDeferredReservedTypes(
          inFlight.mailboxes.has(mailboxHandle),
          inFlight.mailboxes.get(mailboxHandle),
          reservedTypes
        )
      )
      // A later edge (the agent back at its prompt) may postdate the reading; one terminal's
      // mailboxes delivered in the same turn don't.
      inFlight.joinedInFlight ||= inFlight.started
      return true
    }
    const deferral: ProbeDeferral = {
      mailboxes: new Map([
        [mailboxHandle, mergeDeferredReservedTypes(false, undefined, reservedTypes)]
      ]),
      started: false,
      joinedInFlight: false,
      forced: this.forcedRereads.delete(ptyId)
    }
    this.probeDeferrals.set(ptyId, deferral)
    queueMicrotask(() => {
      deferral.started = true
    })
    void Promise.all([
      probeAbsence ? this.deps.isLeafPtyProvenAbsent(ptyId) : false,
      probeShell ? probeShell.read() : false
    ])
      .then(([absent, shellInFront]) => {
        // Any delivery after the read may be the agent's return edge; a shell verdict keeps mail
        // unread only when none joined.
        if (absent || (shellInFront && !deferral.joinedInFlight)) {
          this.probeDeferrals.delete(ptyId)
          return
        }
        // Stays registered until the timer turn, so an arrival in between joins rather than racing it.
        setTimeout(() => {
          this.probeDeferrals.delete(ptyId)
          // A joiner may postdate an "agent in front" read: the agent may have exited meanwhile,
          // which leaves the PTY's incarnation unchanged. Only one such re-read per batch, so a
          // stream of deliveries still types.
          const staleAgent = deferral.joinedInFlight && !deferral.forced
          const stale =
            shellInFront ||
            staleAgent ||
            (probeShell !== null &&
              this.deps.foregroundShellProbe(ptyId)?.incarnationId !== probeShell.incarnationId)
          if (!shellInFront && staleAgent) {
            this.forcedRereads.add(ptyId)
          }
          try {
            // One turn for every mailbox, so a re-probe coalesces them again instead of joining itself.
            for (const [deferredMailbox, reserved] of deferral.mailboxes) {
              redeliver(deferredMailbox, stale, reserved)
            }
          } finally {
            // The re-read took it synchronously, or no delivery reached a read.
            this.forcedRereads.delete(ptyId)
          }
        }, 0)
      })
      .catch(() => this.probeDeferrals.delete(ptyId))
    return true
  }
}
