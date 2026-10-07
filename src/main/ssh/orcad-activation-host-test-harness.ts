/**
 * A stateful fake orcad host for crash-recovery tests: slot processes, PID files, the shared
 * profile state, snapshots, the activation record, the journal and its fence. It can drop the
 * connection at any numbered mutation, before or after the host applied it.
 */
import {
  emptyOrcadActivationRecord,
  parseOrcadActivationRecord,
  withActivatedVersion,
  type OrcadActivationRecord
} from './orcad-activation-record'
import { isSnapshotCaptureCommand } from './orcad-snapshot-capture-command'
import { sshCommandExitError } from './ssh-relay-exec-command'

export const OLD = '0.1.0+aa01'
export const NEW = '0.2.0+bb01'
export const BUILD_HASH = 'abc123def4567890'
/** State the incoming build migrates on load; the outgoing build cannot read it. */
const MIGRATION = '|migrated-by-new'

export type CrashMode = 'before' | 'after'

/** The one-shot readiness read, or the launch loop's host-side wait. */
export function isReadinessRead(command: string): boolean {
  return command.startsWith('head -c ') || command.includes('orcad_readiness_wait')
}

const WAKE_OWNER = '.orca-fence-owner'
const FENCE_GUARD =
  /^\[ "\$\(cat '[^']*' 2>\/dev\/null\)" = '([^']*)' \] \|\| \{ echo (__ORCAD_FENCE_LOST__; exit 75|SUPERSEDED; exit 0); \};\s*/u

export class FakeOrcadHost {
  record: string | null = null
  journal: string | null = null
  fence = false
  /** Set by a recovery takeover, which recreates the lock fresh; the ownerless mark clears it. */
  fenceFresh = false
  wakeOwner: string | null = null
  readonly alive = new Set<string>()
  readonly pidFiles = new Set<string>()
  data = 'profiles-v1'
  readonly snapshots = new Map<string, string>()
  readonly commands: string[] = []
  mutations = 0
  crashAt: number | null = null
  crashMode: CrashMode = 'before'
  /** How the slot's managed-stop command behaves: orcad exits, or keeps serving. */
  managedStop: 'exits' | 'stays' | 'stays-dispatched' = 'exits'
  /** What the daemon reports at a managed stop's terminal fence. */
  retirement: 'retired' | 'live' | 'unverifiable' = 'retired'
  readonly dispatched = new Set<string>()

  static deployedOld(): FakeOrcadHost {
    const host = new FakeOrcadHost()
    host.record = JSON.stringify(
      withActivatedVersion(emptyOrcadActivationRecord(), OLD, null, new Date(0))
    )
    host.alive.add(OLD)
    host.pidFiles.add(OLD)
    return host
  }

  static activatedNew(): FakeOrcadHost {
    const host = FakeOrcadHost.deployedOld()
    host.alive.clear()
    host.pidFiles.add(NEW)
    host.alive.add(NEW)
    host.snapshots.set('pre-0.2.0+bb01-1000', host.data)
    host.data += MIGRATION
    host.record = JSON.stringify(FakeOrcadHost.newRecord())
    return host
  }

  static newRecord(): OrcadActivationRecord {
    return withActivatedVersion(
      {
        ...emptyOrcadActivationRecord(),
        active: OLD,
        activatedAt: new Date(0).toISOString()
      },
      NEW,
      {
        dirName: 'pre-0.2.0+bb01-1000',
        takenBeforeVersion: NEW,
        readableByVersion: OLD,
        takenAt: new Date(1000).toISOString()
      },
      new Date(1000)
    )
  }

  activeVersion(): string | null {
    const parsed = parseOrcadActivationRecord(this.record)
    return parsed.state === 'ok' ? parsed.record.active : null
  }

  /** Every state the old build can read: the pre-migration profile. */
  isReadableBy(version: string | null): boolean {
    return version !== OLD || !this.data.includes(MIGRATION)
  }

  private mutate<T>(apply: () => T): T {
    this.mutations += 1
    if (this.crashAt !== this.mutations) {
      return apply()
    }
    if (this.crashMode === 'after') {
      apply()
    }
    throw Object.assign(new Error(`connection lost at mutation ${this.mutations}`), {
      sshChannelCloseConfirmed: false
    })
  }

  write(path: string, contents: string): void {
    this.mutate(() => {
      if (path.endsWith('transaction.json')) {
        this.journal = contents
      } else if (path.endsWith('orcad-active.json')) {
        this.record = contents
      }
    })
  }

  /** Returns false where a stale-only takeover would answer busy. */
  acquireFence(options?: { allowStaleTakeover?: boolean; owner?: { token: string } }): boolean {
    if (options?.allowStaleTakeover && this.fence && this.fenceFresh) {
      return false
    }
    this.fenceFresh = options?.allowStaleTakeover === true && this.fence
    this.fence = true
    // The real lock writes the holder's generation token in the command that creates it.
    this.wakeOwner = options?.owner?.token ?? this.wakeOwner
    return true
  }

  exec(command: string): string {
    this.commands.push(command)
    return this.execInner(command)
  }

  private execInner(command: string): string {
    const guard = FENCE_GUARD.exec(command)
    if (guard) {
      const owned = this.fence && this.wakeOwner === guard[1]
      if (command.includes('echo RELEASED')) {
        return owned
          ? this.mutate(() => {
              this.journal = null
              this.fence = false
              this.wakeOwner = null
              return 'RELEASED'
            })
          : 'SUPERSEDED'
      }
      if (!owned) {
        throw sshCommandExitError(command, 75, '__ORCAD_FENCE_LOST__\n')
      }
      return this.execInner(command.slice(guard[0].length))
    }
    if (command.startsWith('touch -m -t 200001010000')) {
      this.fenceFresh = false
      return ''
    }
    // The holder's token lives inside the fence's lock dir, so the fence's release drops it.
    // A state mutation's fence heartbeat names the token only to check it is still its own.
    if (command.includes(WAKE_OWNER) && !command.includes('orcad-state-mutation.lock')) {
      return this.wakeOwner === null || !this.fence
        ? '__ORCAD_RECORD_ABSENT__\n'
        : `__ORCAD_RECORD_PRESENT__\n${this.wakeOwner}`
    }
    const version = /\/orcad-(\d+\.\d+\.\d+\+[0-9a-f]+)/u.exec(command)?.[1] ?? null
    const snapshot = /orcad-state-snapshots\/([A-Za-z0-9][A-Za-z0-9.+-]*)/u.exec(command)?.[1]
    if (command.includes('__ORCAD_RECORD_PRESENT__') && command.includes('orcad.lock')) {
      const owner = [...this.alive][0]
      return owner
        ? `__ORCAD_RECORD_PRESENT__\n${JSON.stringify(lockRecord(owner))}`
        : '__ORCAD_RECORD_ABSENT__\n'
    }
    if (command.includes('-managed-stop ') && version) {
      return this.runManagedStopCommand(command, version)
    }
    if (command.includes('__ORCAD_RECORD_PRESENT__')) {
      const value = command.includes('transaction.json') ? this.journal : this.record
      return value === null ? '__ORCAD_RECORD_ABSENT__\n' : `__ORCAD_RECORD_PRESENT__\n${value}`
    }
    if (command.includes('echo LOCKED || echo OPEN')) {
      return this.fence ? 'LOCKED' : 'OPEN'
    }
    if (command.startsWith('rm -f') && command.includes('transaction.json')) {
      return this.mutate(() => {
        this.journal = null
        this.fence = false
        return ''
      })
    }
    if (command.includes('__ORCAD_BUILD_HASH__')) {
      return `__ORCAD_BUILD_HASH__ ${BUILD_HASH}\n`
    }
    if (command.includes('orca-runtime.json')) {
      return this.alive.size > 0 ? 'LIVE orcad.lock 1' : 'CLEAR'
    }
    if (command.includes('echo LIVE;') && version) {
      if (this.alive.has(version)) {
        return 'LIVE'
      }
      return this.pidFiles.has(version) ? 'DEAD' : 'UNKNOWN'
    }
    if (command.includes('kill -TERM') && version) {
      if (!this.pidFiles.has(version)) {
        return 'NO_PID'
      }
      return this.mutate(() => (this.alive.delete(version) ? 'STOPPED' : 'ALREADY_EXITED'))
    }
    if (command.includes('nohup') && version) {
      return this.mutate(() => {
        this.pidFiles.add(version)
        // The instance lock and port admit one owner; a second launch never becomes ready.
        if (this.alive.size === 0) {
          this.alive.add(version)
          if (version === NEW && !this.data.includes(MIGRATION)) {
            this.data += MIGRATION
          }
        }
        return '9999'
      })
    }
    if (isReadinessRead(command) && version) {
      return this.alive.has(version) ? readyLine(version) : ''
    }
    if (command.includes('echo PRESENT') && snapshot) {
      return this.snapshots.has(snapshot) ? 'PRESENT' : 'ABSENT'
    }
    if (command.includes('verdict=UNCHANGED') && snapshot) {
      return this.snapshots.get(snapshot) === this.data ? 'UNCHANGED' : 'CHANGED'
    }
    if (isSnapshotCaptureCommand(command) && snapshot) {
      return this.mutate(() => {
        if (this.data === '') {
          return 'EMPTY'
        }
        this.snapshots.set(snapshot, this.data)
        return 'CAPTURED'
      })
    }
    if (command.includes('.orcad-state-restore-stage') && snapshot) {
      return this.mutate(() => {
        const restored = this.snapshots.get(snapshot)
        if (restored === undefined) {
          return 'MISSING'
        }
        this.data = restored
        return 'RESTORED'
      })
    }
    if (command.includes('then echo RESTORED')) {
      return this.mutate(() => {
        this.data = ''
        return 'RESTORED'
      })
    }
    if (command.includes('stat -c %Y')) {
      return 'UNKNOWN'
    }
    return ''
  }

  /** The slot's `--complete-managed-stop` / `--cancel-managed-stop`, as orcad answers them. */
  private runManagedStopCommand(command: string, version: string): string {
    const request = JSON.parse(command.slice(command.lastIndexOf(" '{") + 2, -1))
    if (command.includes('--cancel-managed-stop')) {
      const outcome = this.dispatched.has(request.transactionId) ? 'dispatched' : 'canceled'
      return JSON.stringify({ ...request, kind: 'orcad_managed_stop_cancellation', outcome })
    }
    const verdict = this.mutate(() => {
      if (this.managedStop === 'exits') {
        this.dispatched.add(request.transactionId)
        this.alive.delete(version)
      } else if (this.managedStop === 'stays-dispatched') {
        this.dispatched.add(request.transactionId)
      }
      return this.alive.has(version) ? 'live' : 'exited'
    })
    return JSON.stringify({
      ...request,
      kind: 'orcad_managed_stop_completion',
      verdict,
      receiptPersisted: verdict === 'exited',
      ...(verdict === 'exited' ? { retirement: this.retirement } : {})
    })
  }
}

function lockRecord(version: string) {
  return {
    pid: 1,
    startedAtMs: null,
    identity: 'uid-1000',
    version,
    acquiredAt: new Date(0).toISOString(),
    nonce: `nonce-${version}`
  }
}

export function readyLine(version: string): string {
  return JSON.stringify({
    type: 'orca_server_ready',
    schemaVersion: 1,
    runtimeId: 'r1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
    health: {
      buildHash: BUILD_HASH,
      buildVersion: version,
      nodeVersion: '24.21.0',
      nodeAbi: '137',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      stopRequests: 1,
      terminalDaemon: {
        state: 'live',
        ownsFreshSessions: true,
        pid: 2,
        buildVersion: version,
        entryPath: '/x/daemon-entry.js',
        protocolVersion: 3,
        selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 5 }
      }
    }
  })
}
