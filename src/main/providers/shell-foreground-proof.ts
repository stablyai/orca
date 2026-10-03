import { admitRemoteForegroundEvidence } from '../../shared/remote-foreground-evidence-admission'
import { isClientOnlyUnverifiableInspection } from '../../shared/terminal-process-inspection'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import type { PtyProcessInspection } from './pty-process-inspection'

/**
 * What a PTY's execution host says about its own shell being back in front:
 * - `shell`: proven; whatever ran in the pane has ended.
 * - `other`: something else is proven in front (an agent, another job, a stopped job, a
 *   multiplexer), which ends with its own command end.
 * - `unread`: the answer could not be trusted (captured before the command end, stale, an
 *   unreadable process table): asking again soon can still prove it.
 * - `unprovable`: the host answered but has no way to tell (a WSL guest, a Windows host, a daemon
 *   that predates foreground evidence).
 * A host that cannot be reached rejects instead: loss of contact is never evidence of an exit.
 */
export type ShellForegroundProof = 'shell' | 'other' | 'unread' | 'unprovable'

export type ShellForegroundProofOptions = {
  expectedIncarnationId?: string
  /** Main's monotonic clock at the command end; evidence captured earlier predates the exit. */
  notCapturedBefore?: number
}

/** Unverifiable reasons that prove something other than the pane's shell holds it. */
const OTHER_IN_FRONT_REASONS = new Set([
  'multiplexer_boundary',
  'tty_boundary',
  'ambiguous_foreground_group'
])

type LiveEvidence = Extract<RemoteForegroundEvidence, { verdict: 'live' }>

/** The fenced live evidence a daemon or relay inspection carries for this PTY incarnation, or the
 *  proof its answer already settles. */
function readLiveEvidence(
  inspection: PtyProcessInspection,
  expected: { ptyId: string; incarnationId: string | null; requestStartedAtMonotonic: number }
): LiveEvidence | ShellForegroundProof {
  // Why throw: a client-only verdict (transport loss) is no answer from the host at all.
  if (isClientOnlyUnverifiableInspection(inspection)) {
    throw new Error(`execution host gave no answer: ${inspection.reason}`)
  }
  if (!('foregroundProcessEvidence' in inspection) || !inspection.foregroundProcessEvidence) {
    return 'unprovable'
  }
  const evidence = admitRemoteForegroundEvidence(inspection.foregroundProcessEvidence, {
    expectedPtyId: expected.ptyId,
    expectedIncarnationId: expected.incarnationId,
    requestStartedAtMonotonic: expected.requestStartedAtMonotonic,
    receivedAtMonotonic: performance.now(),
    lastAuthorityGeneration: null,
    lastObservationEpoch: -1
  })
  if (!evidence) {
    return 'unread'
  }
  if (evidence.verdict === 'unverifiable') {
    if (evidence.reason === 'windows_ssh_foreground_unavailable') {
      return 'unprovable'
    }
    return OTHER_IN_FRONT_REASONS.has(evidence.reason) ? 'other' : 'unread'
  }
  return evidence.verdict === 'live' && evidence.fence.platform === 'posix' ? evidence : 'other'
}

/** Reads an SSH relay's fenced foreground evidence, whose PTY root is the shell itself. */
export function shellForegroundProofFromInspection(
  inspection: PtyProcessInspection,
  expected: {
    ptyId: string
    incarnationId: string | null
    requestStartedAtMonotonic: number
    notCapturedBefore?: number
  }
): ShellForegroundProof {
  const evidence = readLiveEvidence(inspection, expected)
  if (typeof evidence === 'string') {
    return evidence
  }
  // Why: a shared capture that began before the command end still shows the exiting agent in
  // front. `capturedAgeMs` runs from the capture's start to the reply, which left the relay no
  // earlier than the request did, so this bound can only err early.
  if (
    expected.notCapturedBefore !== undefined &&
    expected.requestStartedAtMonotonic - evidence.capturedAgeMs < expected.notCapturedBefore
  ) {
    return 'unread'
  }
  // Why TEMPORARY: this evidence cannot see a stopped job, so a Ctrl+Z'd agent reads as `shell`.
  return evidence.processName === null &&
    evidence.fence.platform === 'posix' &&
    evidence.fence.foregroundPgid === evidence.fence.shellPid
    ? 'shell'
    : 'other'
}

/**
 * The terminal daemon's own confirm proves a shell only after a full-screen exit. Otherwise its
 * fenced evidence names the PTY's root, and this host, which is the daemon's, reads its own process
 * table fresh: on macOS the root is login(1) and the shell its child in another process group, so
 * the evidence's root-is-the-shell test never holds there. A Windows daemon cannot tell.
 */
export async function proveDaemonShellForeground(args: {
  ptyId: string
  incarnationId: string | null
  platform: NodeJS.Platform
  confirmShellForeground: () => Promise<boolean>
  inspectProcess: () => Promise<PtyProcessInspection>
  confirmPaneShellForeground: (rootPid: number) => Promise<boolean>
}): Promise<ShellForegroundProof> {
  if (await args.confirmShellForeground()) {
    return 'shell'
  }
  if (args.platform === 'win32') {
    return 'unprovable'
  }
  const requestStartedAtMonotonic = performance.now()
  const evidence = readLiveEvidence(await args.inspectProcess(), {
    ptyId: args.ptyId,
    incarnationId: args.incarnationId,
    requestStartedAtMonotonic
  })
  if (typeof evidence === 'string' || evidence.fence.platform !== 'posix') {
    return typeof evidence === 'string' ? evidence : 'other'
  }
  return (await args.confirmPaneShellForeground(evidence.fence.shellPid)) ? 'shell' : 'other'
}

/** An SSH relay has no shell confirm; its fenced evidence answers, keyed to the relay's own PTY id. */
export async function proveRelayShellForeground(
  relayPtyId: string,
  options: ShellForegroundProofOptions | undefined,
  inspectProcess: (options?: { expectedIncarnationId: string }) => Promise<PtyProcessInspection>
): Promise<ShellForegroundProof> {
  const expectedIncarnationId = options?.expectedIncarnationId
  const requestStartedAtMonotonic = performance.now()
  const inspection = await inspectProcess(
    expectedIncarnationId ? { expectedIncarnationId } : undefined
  )
  return shellForegroundProofFromInspection(inspection, {
    ptyId: relayPtyId,
    incarnationId: expectedIncarnationId ?? null,
    requestStartedAtMonotonic,
    ...(options?.notCapturedBefore !== undefined
      ? { notCapturedBefore: options.notCapturedBefore }
      : {})
  })
}
