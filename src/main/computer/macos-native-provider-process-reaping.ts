import type { ChildProcess } from 'node:child_process'

export const PROVIDER_SIGKILL_GRACE_MS = 2_000

const reaped = new WeakSet<ChildProcess>()

// Why: signal the child handle, not a raw pid. Node no-ops once the child has
// exited, so a recycled pid can never be signalled.
export function reapMacOSProviderProcess(provider: ChildProcess): void {
  if (reaped.has(provider) || hasProviderExited(provider)) {
    return
  }
  reaped.add(provider)
  // Why: SIGTERM must land synchronously. The sidecar's SIGTERM handler calls
  // process.exit(0) straight after shutdown(), so no deferred timer runs there.
  provider.kill('SIGTERM')
  const escalation = setTimeout(() => {
    if (!hasProviderExited(provider)) {
      provider.kill('SIGKILL')
    }
  }, PROVIDER_SIGKILL_GRACE_MS)
  escalation.unref?.()
  provider.once('exit', () => clearTimeout(escalation))
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
