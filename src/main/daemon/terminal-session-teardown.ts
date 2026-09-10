import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  createPtyStopReceipt,
  type PtyStopProcessIdentity,
  type PtyStopProcessObservation,
  type PtyStopReceipt
} from '../../shared/pty-stop-receipt'
import {
  collectDescendantRows,
  DESCENDANT_KILL_GRACE_MS,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  killWithDescendantSweep,
  readProcessTable,
  readProcessTableBeforeDeadline,
  type KillSweepDeps,
  type ProcessTableRow
} from '../pty-descendant-termination'
import type { Session } from './session'

type SessionTeardownOperation = {
  promise: Promise<PtyStopReceipt>
  immediate: boolean
  rootSignalled: boolean
  rootCompletion: Promise<void>
  session: Session
}

type SettledSessionTeardown = { receipt: PtyStopReceipt; immediate: boolean }
const WINDOWS_TREE_LIMIT_REASON = 'Windows tree verification is capability-limited.'

export type PtyProcessTreeStopEvidence = {
  root: PtyStopProcessIdentity
  descendants: PtyStopProcessIdentity[]
  observations: PtyStopProcessObservation[]
  verdict: 'exited' | 'live' | 'unverifiable' | 'capability_limited'
  processTreeVerified: boolean
  reason?: string
}

/** Stops and verifies the exact process identities captured before root signalling. */
export async function stopPtyProcessTree(
  rootPid: number,
  killRoot: () => void,
  deps: KillSweepDeps = {}
): Promise<PtyProcessTreeStopEvidence> {
  if ((deps.platform ?? process.platform) === 'win32') {
    await killWithDescendantSweep(rootPid, killRoot, deps)
    return unresolvedTree(rootPid, WINDOWS_TREE_LIMIT_REASON, 'capability_limited')
  }
  const readTable = deps.readTable ?? readProcessTable
  const timeoutMs = deps.timeoutMs ?? DESCENDANT_SNAPSHOT_TIMEOUT_MS
  const capture = await readProcessTableBeforeDeadline(readTable, timeoutMs)
  if (!capture) {
    killRoot()
    return unresolvedTree(rootPid, 'The pre-stop process snapshot was unavailable.')
  }
  const rootRow = capture.rows.find(({ pid }) => pid === rootPid)
  if (!rootRow || !(deps.ownsRoot?.() ?? true)) {
    killRoot()
    return unresolvedTree(rootPid, 'The PTY root identity could not be proven before stop.')
  }
  const snapshot = collectDescendantRows(rootPid, capture.rows, capture.capturedAtMs)
  const root = toIdentity(rootRow)
  const descendants = snapshot.descendants.map(toIdentity)
  const sendSignal = deps.sendSignal ?? sendProcessSignal
  await killWithDescendantSweep(rootPid, killRoot, {
    ...deps,
    readTable: async () => capture,
    sendSignal
  })
  const graceMs = deps.graceMs ?? DESCENDANT_KILL_GRACE_MS
  if (graceMs > 0) {
    await waitInterval(graceMs)
  }
  const escalationCapture = await readProcessTableBeforeDeadline(readTable, timeoutMs)
  if (!escalationCapture) {
    return capturedTreeUnverifiable(root, descendants, 'The post-stop snapshot failed.')
  }
  const escalation = observeIdentities([root, ...descendants], escalationCapture.rows)
  const liveDescendants = escalation.filter(
    ({ identity, status }) => status === 'live' && identity.pid !== rootPid && identity.pid !== null
  )
  liveDescendants.forEach(({ identity }) => sendSignal(identity.pid!, 'SIGKILL'))
  if (liveDescendants.length > 0 && graceMs > 0) {
    await waitInterval(50)
  }
  const finalCapture = await readProcessTableBeforeDeadline(readTable, timeoutMs)
  if (!finalCapture) {
    return capturedTreeUnverifiable(root, descendants, 'The final observation failed.')
  }
  const observations = observeIdentities([root, ...descendants], finalCapture.rows)
  if (observations.some(({ status }) => status === 'unverifiable')) {
    return stoppedTreeResult(
      root,
      descendants,
      observations,
      'unverifiable',
      'A captured identity could not be observed unambiguously.'
    )
  }
  if (observations.some(({ status }) => status === 'live')) {
    return stoppedTreeResult(
      root,
      descendants,
      observations,
      'live',
      'One or more captured process identities remain live.'
    )
  }
  return { root, descendants, observations, verdict: 'exited', processTreeVerified: true }
}

/** Owns exact-session teardown until the root and every captured descendant have a verdict. */
export class TerminalSessionTeardown {
  private operations = new Map<string, SessionTeardownOperation>()
  private receipts = new Map<string, SettledSessionTeardown>()

  constructor(private sessions: ReadonlyMap<string, Session>) {}

  get(sessionId: string): Promise<PtyStopReceipt> | undefined {
    return this.operations.get(sessionId)?.promise
  }

  /** Waits until the teardown for this id releases its exact process incarnation. */
  async settle(sessionId: string): Promise<void> {
    await this.operations.get(sessionId)?.promise.catch(() => undefined)
  }

  getReceipt(
    sessionId: string,
    opts: { expectedIncarnationId?: string; immediate?: boolean } = {}
  ): PtyStopReceipt | undefined {
    const settled = this.receipts.get(sessionId)
    if (
      !settled ||
      (opts.expectedIncarnationId &&
        settled.receipt.ptyIncarnation !== opts.expectedIncarnationId) ||
      (opts.immediate && !settled.immediate && this.sessions.get(sessionId)?.isAlive)
    ) {
      return undefined
    }
    return settled.receipt
  }

  clearReceipt(sessionId: string): void {
    this.receipts.delete(sessionId)
  }

  requestImmediate(sessionId: string): Promise<PtyStopReceipt> | undefined {
    const pending = this.operations.get(sessionId)
    if (pending) {
      pending.immediate = true
      if (pending.rootSignalled && pending.session.isAlive) {
        pending.rootCompletion = pending.session.forceKillAndWaitForExit()
      }
    }
    return pending?.promise
  }

  killSession(sessionId: string, session: Session, immediate: boolean): Promise<PtyStopReceipt> {
    const pending = this.operations.get(sessionId)
    if (pending) {
      pending.immediate ||= immediate
      return pending.promise
    }
    if (!session.beginTermination()) {
      const settled = this.receipts.get(sessionId)
      const canUpgrade = settled && immediate && !settled.immediate && session.isAlive
      if (!canUpgrade) {
        if (settled?.receipt.ptyIncarnation === session.incarnationId) {
          return Promise.resolve(settled.receipt)
        }
        throw new Error(`Session "${sessionId}" stop identity is unavailable`)
      }
    }
    if (!immediate) {
      session.scheduleForceDisposeFallback()
    }

    const entry: SessionTeardownOperation = {
      promise: Promise.resolve(undefined as never),
      immediate,
      rootSignalled: false,
      rootCompletion: Promise.resolve(),
      session
    }
    entry.promise = this.stopSession(sessionId, entry)
    this.operations.set(sessionId, entry)
    const finish = (receipt: PtyStopReceipt): PtyStopReceipt => {
      if (this.operations.get(sessionId) === entry) {
        this.operations.delete(sessionId)
      }
      this.receipts.set(sessionId, { receipt, immediate: entry.immediate })
      return receipt
    }
    const fail = (error: unknown): never => {
      if (this.operations.get(sessionId) === entry) {
        this.operations.delete(sessionId)
      }
      throw error
    }
    entry.promise = entry.promise.then(finish, fail)
    return entry.promise
  }

  private async stopSession(
    sessionId: string,
    entry: SessionTeardownOperation
  ): Promise<PtyStopReceipt> {
    const session = entry.session
    const evidence = await stopPtyProcessTree(
      session.pid,
      () => {
        if (!session.isAlive) {
          return
        }
        entry.rootSignalled = true
        if (entry.immediate) {
          entry.rootCompletion = session.forceKillAndWaitForExit()
        } else {
          session.signalTerminationRoot()
        }
      },
      {
        ownsRoot: () => this.sessions.get(sessionId) === session && session.isAlive,
        terminateOwnedTree: () => session.terminateOwnedTree()
      }
    )
    await entry.rootCompletion.catch(() => undefined)
    return createPtyStopReceipt({
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      terminalHandle: session.terminalHandle ?? sessionId,
      ptyId: sessionId,
      ptyIncarnation: session.incarnationId,
      root: evidence.root,
      descendants: evidence.descendants,
      observations: evidence.observations,
      verdict: evidence.verdict,
      processTreeVerified: evidence.processTreeVerified,
      ...(evidence.reason ? { reason: evidence.reason } : {})
    })
  }
}

function toIdentity(row: ProcessTableRow): PtyStopProcessIdentity {
  return { pid: row.pid, parentPid: row.ppid, processGroupId: row.pgid, startedAt: row.startedAt }
}

function observeIdentities(
  identities: readonly PtyStopProcessIdentity[],
  rows: readonly ProcessTableRow[]
): PtyStopProcessObservation[] {
  const rowsByPid = new Map<number, ProcessTableRow | null>()
  rows.forEach((row) => rowsByPid.set(row.pid, rowsByPid.has(row.pid) ? null : row))
  const observedAt = new Date().toISOString()
  return identities.map((identity) => {
    const current = identity.pid === null ? null : rowsByPid.get(identity.pid)
    const status =
      current === null
        ? 'unverifiable'
        : current &&
            current.ppid === identity.parentPid &&
            current.pgid === identity.processGroupId &&
            current.startedAt === identity.startedAt
          ? 'live'
          : 'absent'
    return { identity, status, observedAt }
  })
}

function unresolvedTree(
  rootPid: number,
  reason: string,
  verdict: 'unverifiable' | 'capability_limited' = 'unverifiable'
): PtyProcessTreeStopEvidence {
  const root = { pid: rootPid, parentPid: null, processGroupId: null, startedAt: null }
  return stoppedTreeResult(
    root,
    [],
    [{ identity: root, status: 'unverifiable', observedAt: new Date().toISOString() }],
    verdict,
    reason
  )
}

function capturedTreeUnverifiable(
  root: PtyStopProcessIdentity,
  descendants: PtyStopProcessIdentity[],
  reason: string
): PtyProcessTreeStopEvidence {
  const observedAt = new Date().toISOString()
  const observations: PtyStopProcessObservation[] = [root, ...descendants].map((identity) => ({
    identity,
    status: 'unverifiable',
    observedAt
  }))
  return stoppedTreeResult(root, descendants, observations, 'unverifiable', reason)
}

function stoppedTreeResult(
  root: PtyStopProcessIdentity,
  descendants: PtyStopProcessIdentity[],
  observations: PtyStopProcessObservation[],
  verdict: 'live' | 'unverifiable' | 'capability_limited',
  reason: string
): PtyProcessTreeStopEvidence {
  return { root, descendants, observations, verdict, processTreeVerified: false, reason }
}

function sendProcessSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // The exact identity is already absent.
  }
}

function waitInterval(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
  })
}
