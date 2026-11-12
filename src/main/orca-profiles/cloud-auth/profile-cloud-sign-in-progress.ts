import type { OrcaCloudSignInEnd, OrcaCloudSignInProgress } from '../../../shared/orca-profiles'

type ProgressListener = (progress: OrcaCloudSignInProgress | null, end?: OrcaCloudSignInEnd) => void

// One sign-in at a time: a newer attempt cancels the older one (its loopback listener closes), and
// Cancel clears the pending state at once, so nothing can leave the app stuck on "Signing in…".
let current: { attempt: number; link: string | null; cancel: () => void } | null = null
const listeners = new Set<ProgressListener>()

function snapshot(): OrcaCloudSignInProgress | null {
  return current ? { link: current.link } : null
}

function update(next: typeof current, end?: OrcaCloudSignInEnd): void {
  current = next
  const progress = snapshot()
  for (const listener of listeners) {
    try {
      listener(progress, end)
    } catch (error) {
      console.warn('[orca-profiles] Sign-in progress listener failed:', error)
    }
  }
}

function cancelQuietly(cancel: () => void): void {
  try {
    cancel()
  } catch (error) {
    console.warn('[orca-profiles] Cancelling a sign-in failed:', error)
  }
}

export function getOrcaCloudSignInProgress(): OrcaCloudSignInProgress | null {
  return snapshot()
}

export function onOrcaCloudSignInProgressChanged(listener: ProgressListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Starts tracking `attempt`; an older pending attempt is cancelled (a second click supersedes it). */
export function startOrcaCloudSignInProgress(attempt: number, cancel: () => void): void {
  const previous = current
  update({ attempt, link: null, cancel })
  if (previous && previous.attempt !== attempt) {
    cancelQuietly(previous.cancel)
  }
}

export function setOrcaCloudSignInLink(attempt: number, link: string | null): void {
  if (current?.attempt === attempt && current.link !== link) {
    update({ ...current, link })
  }
}

export function endOrcaCloudSignInProgress(attempt?: number, end?: OrcaCloudSignInEnd): void {
  if (current && (attempt === undefined || current.attempt === attempt)) {
    update(null, end)
  }
}

/** Cancel: aborts the pending attempt (closing its loopback listener) and clears progress now. */
export function cancelOrcaCloudSignIn(): void {
  const pending = current
  if (!pending) {
    return
  }
  update(null)
  cancelQuietly(pending.cancel)
}

/** Test-only. */
export function resetOrcaCloudSignInProgressForTests(): void {
  current = null
  listeners.clear()
}
