import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'
import {
  isConfiguredTerminalLimit,
  MAX_CONFIGURED_TERMINALS,
  terminalLimitInputMaximum,
  type TerminalLimitStatus
} from '../../shared/terminal-limit-policy'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { isSafeOwnedDirectory } from '../../shared/owned-private-directory'
import { awaitDaemonValueWithinCallerDeadline } from './daemon-request-deadline'
import { DEFAULT_MAX_HOST_TERMINALS, resolveMaxHostTerminals } from './host-terminal-ledger'
import { SystemPtyLimit } from './system-pty-limit'

export function hostTerminalPolicyPath(home: string, machine: string | null): string | null {
  if (!machine) {
    return null
  }
  const key = createHash('sha256')
    .update(`${process.platform}:${machine}`)
    .digest('hex')
    .slice(0, 16)
  return join(home, '.orca', 'host-settings', key, 'terminals.json')
}

async function readSavedMaximum(path: string): Promise<number | null> {
  try {
    const { buffer, stats } = await readNodeFileWithinLimit(path, 1024, { regularFileOnly: true })
    if (process.getuid && stats.uid !== process.getuid()) {
      throw new Error('Policy owner changed')
    }
    const saved: unknown = JSON.parse(buffer.toString('utf8'))
    if (
      typeof saved !== 'object' ||
      saved === null ||
      !('schemaVersion' in saved) ||
      saved.schemaVersion !== 1 ||
      !('maxTerminals' in saved) ||
      !isConfiguredTerminalLimit(saved.maxTerminals)
    ) {
      throw new Error('Invalid terminal policy')
    }
    return saved.maxTerminals
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

type PolicyOperation = {
  isCurrent: () => boolean
  wait: <T>(load: () => Promise<T>) => Promise<T>
}

async function withPolicyOperation<T>(
  isHostCurrent: () => boolean,
  deadline: number,
  work: (operation: PolicyOperation) => Promise<T>
): Promise<T> {
  let active = true
  const isCurrent = (): boolean => active && Date.now() < deadline && isHostCurrent()
  const check = (): void => {
    if (!isCurrent()) {
      throw new Error('Couldn’t confirm the terminal setting. Refresh and try again.')
    }
  }
  const operation: PolicyOperation = {
    isCurrent,
    wait: async (load) => {
      check()
      const result = await awaitDaemonValueWithinCallerDeadline(load(), deadline)
      check()
      if (!result.completed) {
        throw new Error('Couldn’t confirm the terminal setting. Refresh and try again.')
      }
      return result.value
    }
  }
  try {
    const result = await work(operation)
    check()
    return result
  } finally {
    active = false
  }
}

export class HostTerminalPolicy {
  private defaultMaximum = DEFAULT_MAX_HOST_TERMINALS
  private savedMaximum: number | null = null
  private savedUnreadable = false
  private revision = 0
  private disposed = false
  private reading = false
  private initialization?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private log: (event: string, details: Record<string, unknown>) => void = () => {}
  private readonly environment: number | null

  constructor(
    readonly path: string | null = hostTerminalPolicyPath(
      homedir(),
      profileStateAccessMachineIdentity()
    ),
    env: NodeJS.ProcessEnv = process.env,
    private readonly system = new SystemPtyLimit(),
    private readonly readSaved: (path: string) => Promise<number | null> = readSavedMaximum
  ) {
    const raw = env.ORCA_DAEMON_MAX_HOST_TERMINALS?.trim()
    this.environment =
      raw && /^\d+$/.test(raw) && isConfiguredTerminalLimit(Number(raw))
        ? resolveMaxHostTerminals(env)
        : null
  }

  start(log = this.log): Promise<void> {
    this.log = log
    return (this.initialization ??= this.system.read().then(async (systemPtyLimit) => {
      if (this.disposed) {
        return
      }
      this.defaultMaximum =
        systemPtyLimit === null
          ? DEFAULT_MAX_HOST_TERMINALS
          : Math.min(Math.ceil(systemPtyLimit / 2), MAX_CONFIGURED_TERMINALS)
      await awaitDaemonValueWithinCallerDeadline(this.refresh(), Date.now() + 250)
      if (!this.disposed && this.path && this.environment === null) {
        this.timer = setInterval(() => void this.refresh(), 3_000)
        this.timer.unref?.()
      }
    }))
  }

  dispose(): void {
    this.disposed = true
    this.revision += 1
    clearInterval(this.timer)
  }

  private async refresh(): Promise<void> {
    if (this.disposed || this.reading || !this.path || this.environment !== null) {
      return
    }
    const path = this.path
    const revision = this.revision
    this.reading = true
    try {
      const maximum = await this.readSaved(path)
      if (this.disposed || revision !== this.revision) {
        return
      }
      if (maximum === null && this.savedMaximum !== null) {
        throw new Error('Saved terminal limit unavailable')
      }
      this.savedMaximum = maximum
      this.setReadHealth(false)
    } catch {
      if (!this.disposed && revision === this.revision) {
        this.setReadHealth(true)
      }
    } finally {
      this.reading = false
      if (!this.disposed && revision !== this.revision) {
        void this.refresh()
      }
    }
  }

  private setReadHealth(failed: boolean): void {
    if (failed === this.savedUnreadable) {
      return
    }
    this.savedUnreadable = failed
    try {
      this.log(failed ? 'terminal-policy-read-failed' : 'terminal-policy-read-recovered', {
        maxTerminals: this.admissionMaximum()
      })
    } catch {
      // Diagnostics cannot change the applied limit.
    }
  }

  admissionMaximum(): number {
    return this.environment ?? this.savedMaximum ?? this.defaultMaximum
  }

  private observedStatus(systemPtyLimit: number | null, daemonNonce: string): TerminalLimitStatus {
    return {
      maxTerminals: this.admissionMaximum(),
      source:
        this.environment !== null
          ? 'environment'
          : this.savedMaximum !== null
            ? 'saved'
            : 'default',
      ...(this.savedUnreadable ? { savedUnreadable: true } : {}),
      systemPtyLimit,
      editable: this.environment === null && this.path !== null,
      daemonNonce
    }
  }

  status(
    daemonNonce: string,
    isCurrent: () => boolean = () => true,
    deadline = Date.now() + 2_000
  ): Promise<TerminalLimitStatus> {
    return withPolicyOperation(isCurrent, deadline, async (operation) => {
      const systemPtyLimit = await operation.wait(() => this.system.read())
      return this.observedStatus(systemPtyLimit, daemonNonce)
    })
  }

  save(
    maximum: number,
    isCurrent: () => boolean,
    daemonNonce = '',
    deadline = Date.now() + 2_000
  ): Promise<TerminalLimitStatus> {
    this.revision += 1
    const current = (): boolean => !this.disposed && isCurrent()
    return withPolicyOperation(current, deadline, async (operation) => {
      const path = this.path
      if (!path || this.environment !== null) {
        throw new Error('Terminal setting unavailable')
      }
      const systemPtyLimit = await operation.wait(() => this.system.read())
      if (
        !isConfiguredTerminalLimit(maximum) ||
        maximum > terminalLimitInputMaximum(systemPtyLimit)
      ) {
        throw new Error('Terminal limit exceeds host capacity')
      }
      const directory = dirname(path)
      await operation.wait(() => mkdir(directory, { recursive: true, mode: 0o700 }))
      if (!isSafeOwnedDirectory(await operation.wait(() => lstat(directory)))) {
        throw new Error('Terminal policy directory is not private')
      }
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      let staging: Promise<unknown> = Promise.resolve()
      try {
        await operation.wait(() => {
          staging = writeFile(
            temporary,
            JSON.stringify({ schemaVersion: 1, maxTerminals: maximum }),
            {
              flag: 'wx',
              mode: 0o600
            }
          )
          return staging
        })
        const replaced = await operation.wait(() => {
          const rename = renameFileWithWindowsRetryAsync(temporary, path, operation.isCurrent)
          const committed = rename.then((replaced) => {
            if (replaced && !this.disposed) {
              this.revision += 1
              if (operation.isCurrent()) {
                this.savedMaximum = maximum
                this.setReadHealth(false)
              } else {
                void this.refresh()
              }
            }
            return replaced
          })
          staging = committed
          return committed
        })
        if (!replaced) {
          throw new Error('Terminal host changed')
        }
        return this.observedStatus(systemPtyLimit, daemonNonce)
      } finally {
        // A late staging write must settle before removal can consume its temporary file.
        void staging
          .catch(() => undefined)
          .then(() => rm(temporary, { force: true }))
          .catch(() => undefined)
      }
    })
  }
}
