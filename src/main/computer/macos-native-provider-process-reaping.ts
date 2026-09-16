import type { ChildProcessHandle as ChildProcess } from '../../shared/child-process/run-process'

export const PROVIDER_SIGKILL_GRACE_MS = 2_000

const reaped = new WeakSet<ChildProcess>()
const pendingReaps = new Set<() => void>()

function forcePendingReaps(): void {
  for (const forceReap of pendingReaps) {
    forceReap()
  }
}

// Why: signal the child handle, not a raw pid. Node no-ops once the child has
// exited, so a recycled pid can never be signalled.
export function reapMacOSProviderProcess(provider: ChildProcess): void {
  if (reaped.has(provider) || hasProviderExited(provider)) {
    return
  }
  reaped.add(provider)
  const cleanup = (): void => {
    clearTimeout(escalation)
    provider.off('exit', cleanup)
    pendingReaps.delete(forceReap)
    if (pendingReaps.size === 0) {
      process.off('exit', forcePendingReaps)
    }
  }
  const forceReap = (): void => {
    try {
      if (!hasProviderExited(provider)) {
        provider.kill('SIGKILL')
      }
    } finally {
      cleanup()
    }
  }
  const escalation = setTimeout(forceReap, PROVIDER_SIGKILL_GRACE_MS)
  escalation.unref()
  if (pendingReaps.size === 0) {
    // Sidecar shutdown calls process.exit(), so timer escalation alone can strand a helper.
    process.once('exit', forcePendingReaps)
  }
  pendingReaps.add(forceReap)
  provider.once('exit', cleanup)
  provider.kill('SIGTERM')
}

export class MacOSProviderProcessOwner {
  private provider: ChildProcess | null = null

  // Why: adopting a new generation must never strand the previous one, whatever
  // teardown did or did not run first.
  adopt(provider: ChildProcess): void {
    this.reap()
    this.provider = provider
  }

  reap(): void {
    const provider = this.provider
    this.provider = null
    if (provider) {
      reapMacOSProviderProcess(provider)
    }
  }
}

// Why: typeof, not `!== null` — test doubles leave these undefined, which
// `!== null` would read as "already exited" and silently skip the reap.
function hasProviderExited(provider: ChildProcess): boolean {
  return typeof provider.exitCode === 'number' || typeof provider.signalCode === 'string'
}
