import type {
  CreateOrAttachResult,
  DaemonEvent,
  SessionInfo,
  TerminalSnapshot
} from '../../main/daemon/types'
import { TerminalDaemonConnection } from './terminal-daemon-socket'

const DETACH_PREFIX_BYTE = 0x1c // Ctrl-\
const DETACH_CONFIRM_BYTE = 0x71 // q
const DETACH_TIMEOUT_MS = 5_000

export type TerminalAttachOptions = { readOnly: boolean }

type AttachOutcome = { kind: 'detach' } | { kind: 'exit'; code: number | null }

/** Attach the local terminal to the live daemon session behind `handle`. */
export async function attachToTerminalDaemon(
  handle: string,
  options: TerminalAttachOptions
): Promise<void> {
  const connection = await TerminalDaemonConnection.connect()
  let outcome: AttachOutcome | undefined
  let sessionId: string | undefined
  // Why: teardown must run on every exit path (normal, throw, signal) so raw mode
  // is always restored and no listener leaks; register steps as they succeed.
  const teardown: (() => void)[] = []
  const { promise: bridgeEnded, resolve: endBridge } = Promise.withResolvers<AttachOutcome>()
  try {
    const sessions = await connection.request<{ sessions: SessionInfo[] }>(
      'listSessions',
      undefined
    )
    const session = sessions.sessions.find(
      (candidate) => candidate.terminalHandle === handle && candidate.isAlive
    )
    if (!session) {
      throw new Error(`No live terminal for handle "${handle}".`)
    }
    sessionId = session.sessionId
    const attach = await connection.request<CreateOrAttachResult>('createOrAttach', {
      sessionId,
      cols: session.cols,
      rows: session.rows,
      attachOnly: true
    })
    renderSnapshot(attach.snapshot)

    connection.onEvent(
      (raw) => {
        const event = raw as DaemonEvent
        if (event.sessionId !== sessionId) {
          return
        }
        if (event.event === 'data') {
          process.stdout.write(event.payload.data)
        } else if (event.event === 'exit') {
          endBridge({ kind: 'exit', code: event.payload.code ?? null })
        }
        // Why: terminalError/backgroundMarker/dataGap/transientFact are diagnostics; an attached viewer ignores them.
      },
      // Why: the daemon dropped our stream (session gone / daemon exit); settle
      // the bridge so teardown runs instead of awaiting forever.
      () => endBridge({ kind: 'exit', code: null })
    )

    const restoreTty = enterRawMode()
    teardown.push(restoreTty)
    let detachPrefixPending = false
    const onStdinData = (chunk: Buffer): void => {
      const scan = scanForDetach(chunk, detachPrefixPending)
      detachPrefixPending = scan.prefixPending
      if (scan.detached) {
        endBridge({ kind: 'detach' })
        return
      }
      // Why: read-only still scans for the detach key but never writes to the PTY.
      if (!options.readOnly && scan.bytes.length > 0) {
        connection.notify('write', { sessionId, data: Buffer.from(scan.bytes).toString('utf8') })
      }
    }
    const onResize = (): void => {
      const size = currentTerminalSize()
      if (size) {
        connection.notify('resize', { sessionId, ...size })
      }
    }
    const onSignal = (): void => endBridge({ kind: 'detach' })
    // Why: read stdin in both modes so Ctrl-\ q always detaches; only the PTY
    // write and resize are suppressed under --read-only.
    if (process.stdin.isTTY) {
      process.stdin.on('data', onStdinData)
      teardown.push(() => {
        process.stdin.removeListener('data', onStdinData)
        // Why: raw-mode stdin keeps the event loop alive; without this the CLI
        // process hangs after detach instead of exiting.
        process.stdin.pause()
      })
    }
    if (!options.readOnly) {
      const size = currentTerminalSize()
      if (size && (size.cols !== session.cols || size.rows !== session.rows)) {
        connection.notify('resize', { sessionId, ...size })
      }
      if (process.platform !== 'win32') {
        process.on('SIGWINCH', onResize)
        teardown.push(() => process.removeListener('SIGWINCH', onResize))
      }
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    teardown.push(() => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    })
    process.stderr.write(`Attached to ${handle}. Detach with Ctrl-\\ then q.\n`)

    outcome = await bridgeEnded
  } finally {
    // Why: run in reverse so raw mode is restored last, after listeners are gone.
    for (const step of teardown.toReversed()) {
      try {
        step()
      } catch {
        // Why: one failing teardown step must not skip the rest (esp. restoreTty).
      }
    }
    if (outcome?.kind === 'detach' && sessionId !== undefined) {
      try {
        await connection.request('detach', { sessionId }, DETACH_TIMEOUT_MS)
      } catch {
        // Why: best effort — the session and its process must keep running regardless.
      }
    }
    connection.close()
    if (outcome?.kind === 'exit' && outcome.code !== null) {
      process.exitCode = outcome.code
    }
  }
}

// Why: Ctrl-\ is the detach prefix; a following q detaches, anything else forwards the swallowed byte.
export function scanForDetach(
  chunk: Buffer,
  prefixPending: boolean
): { bytes: number[]; detached: boolean; prefixPending: boolean } {
  const bytes: number[] = []
  let detached = false
  for (const byte of chunk) {
    if (prefixPending) {
      prefixPending = false
      if (byte === DETACH_CONFIRM_BYTE) {
        detached = true
        break
      }
      bytes.push(DETACH_PREFIX_BYTE, byte)
      continue
    }
    if (byte === DETACH_PREFIX_BYTE) {
      prefixPending = true
      continue
    }
    bytes.push(byte)
  }
  return { bytes, detached, prefixPending }
}

function renderSnapshot(snapshot: TerminalSnapshot | null): void {
  if (!snapshot) {
    return
  }
  process.stdout.write(
    snapshot.rehydrateSequences + snapshot.snapshotAnsi + (snapshot.pendingEscapeTailAnsi ?? '')
  )
}

function currentTerminalSize(): { cols: number; rows: number } | null {
  const { columns: cols, rows } = process.stdout
  return cols && rows ? { cols, rows } : null
}

function enterRawMode(): () => void {
  if (!process.stdin.isTTY) {
    return () => {}
  }
  process.stdin.setRawMode(true)
  return () => process.stdin.setRawMode(false)
}
