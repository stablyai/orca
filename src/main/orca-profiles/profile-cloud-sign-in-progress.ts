import type { OrcaCloudSignInProgress } from '../../shared/orca-profiles'

type ProgressListener = (progress: OrcaCloudSignInProgress | null) => void

// Why one record: the newest attempt owns the progress, so an older attempt's late calls are no-ops.
let current: { attempt: number; link: string | null; cancel: () => void } | null = null
const listeners = new Set<ProgressListener>()

function snapshot(): OrcaCloudSignInProgress | null {
  return current ? { link: current.link } : null
}

function update(next: typeof current): void {
  current = next
  const progress = snapshot()
  for (const listener of listeners) {
    try {
      listener(progress)
    } catch (error) {
      console.warn('[orca-profiles] Sign-in progress listener failed:', error)
    }
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

export function startOrcaCloudSignInProgress(attempt: number, cancel: () => void): void {
  update({ attempt, link: null, cancel })
}

export function setOrcaCloudSignInLink(attempt: number, link: string | null): void {
  if (current?.attempt === attempt && current.link !== link) {
    update({ ...current, link })
  }
}

export function endOrcaCloudSignInProgress(attempt?: number): void {
  if (current && (attempt === undefined || current.attempt === attempt)) {
    update(null)
  }
}

export function cancelOrcaCloudSignIn(): void {
  current?.cancel()
}
