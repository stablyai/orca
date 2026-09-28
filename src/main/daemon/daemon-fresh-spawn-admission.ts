import type { PtySpawnOptions } from '../providers/types'
import { terminalServiceUnavailable } from '../providers/unavailable-pty-provider'
import { STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'

export class DaemonFreshSpawnAdmission {
  private recovery: Promise<boolean> | null = null
  private retryAfter = 0
  private generation = 0

  constructor(private probe: (() => Promise<boolean>) | null) {}

  reset(probe: (() => Promise<boolean>) | null): void {
    this.generation += 1
    this.probe = probe
    this.recovery = null
    this.retryAfter = 0
  }

  get unavailable(): boolean {
    return this.probe !== null
  }

  recover(force = false): Promise<boolean> {
    if (!this.probe) {
      return Promise.resolve(true)
    }
    if (this.recovery) {
      return this.recovery
    }
    if (!force && Date.now() < this.retryAfter) {
      return Promise.resolve(false)
    }
    const generation = this.generation
    this.recovery = Promise.resolve()
      .then(this.probe)
      .catch(() => false)
      .then((healthy) => {
        if (generation !== this.generation) {
          return this.recover(force)
        }
        if (healthy) {
          this.probe = null
        } else {
          this.retryAfter = Date.now() + 30_000
        }
        return healthy
      })
      .finally(() => {
        if (generation === this.generation) {
          this.recovery = null
        }
      })
    return this.recovery
  }
}

export async function admitDaemonSpawn(
  admission: DaemonFreshSpawnAdmission,
  opts: PtySpawnOptions,
  protocolVersion: number,
  sessionExists: () => Promise<boolean>
): Promise<PtySpawnOptions> {
  if (opts.attachOnly || (await admission.recover())) {
    return opts
  }
  if (
    opts.isNewSession ||
    protocolVersion < STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION ||
    !(await sessionExists())
  ) {
    throw terminalServiceUnavailable()
  }
  // Prevent a retained session's exit during admission from turning attachment into creation.
  return { ...opts, attachOnly: true }
}
