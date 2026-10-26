import { SessionInputClosedError } from './daemon-errors'
import type { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { CreateOrAttachOptions } from './terminal-host-create-contract'

type SessionInputPath = {
  subprocess: SubprocessHandle
  viewer: CreateOrAttachOptions['streamClient'] | null
}

// Keyed by Session so an exited or replaced generation can never answer for its successor.
const inputPaths = new WeakMap<Session, SessionInputPath>()

/** Watch for a live child whose PTY master stops taking input, and tell its current viewer. */
export function trackSessionInput(
  session: Session,
  subprocess: SubprocessHandle,
  report?: (event: string, details: Record<string, unknown>) => void
): void {
  const path: SessionInputPath = { subprocess, viewer: null }
  inputPaths.set(session, path)
  subprocess.onInputClosed?.((reason) => {
    if (!session.isAlive) {
      return
    }
    try {
      report?.('pty-input-closed', { sessionId: session.sessionId, reason })
    } catch {
      // Diagnostics must never stop the viewer from learning input is gone.
    }
    path.viewer?.onInputClosed?.(session.incarnationId)
  })
}

/** Attach replaces every earlier viewer, so only the latest one is told. */
export function attachSessionInputViewer(
  session: Session,
  viewer: CreateOrAttachOptions['streamClient']
): void {
  const path = inputPaths.get(session)
  if (path) {
    path.viewer = viewer
  }
}

export function isSessionInputClosed(session: Session): boolean {
  return session.isAlive && inputPaths.get(session)?.subprocess.isInputClosed?.() === true
}

/** Dropping bytes a retired master cannot take would let every caller report delivery. */
export function writeSessionInput(session: Session, data: string): void {
  if (isSessionInputClosed(session)) {
    throw new SessionInputClosedError(session.sessionId)
  }
  session.write(data)
  // A native write failure during this call also retires the master.
  if (isSessionInputClosed(session)) {
    throw new SessionInputClosedError(session.sessionId)
  }
}
