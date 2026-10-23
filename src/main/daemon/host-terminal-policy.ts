import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { InFlightPromiseDedupe } from '../../shared/in-flight-promise-dedupe'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'
import {
  isConfiguredTerminalLimit,
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
  private readonly reads = new InFlightPromiseDedupe<number | null>(0, 1)
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

  private saved(): Promise<number | null> {
    const path = this.path
    return path ? this.reads.run('policy', () => this.readSaved(path)) : Promise.resolve(null)
  }

  async admissionMaximum(): Promise<number> {
    if (this.environment !== null) {
      return this.environment
    }
    try {
      const read = await awaitDaemonValueWithinCallerDeadline(this.saved(), Date.now() + 250)
      return (read.completed ? read.value : null) ?? DEFAULT_MAX_HOST_TERMINALS
    } catch {
      // Settings storage cannot prevent a user from starting a terminal.
      return DEFAULT_MAX_HOST_TERMINALS
    }
  }

  private observedStatus(
    saved: number | null,
    systemPtyLimit: number | null,
    daemonNonce: string
  ): TerminalLimitStatus {
    return {
      maxTerminals: this.environment ?? saved ?? DEFAULT_MAX_HOST_TERMINALS,
      source: this.environment !== null ? 'environment' : saved !== null ? 'saved' : 'default',
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
      const [saved, systemPtyLimit] = await operation.wait(() =>
        Promise.all([
          this.environment === null ? this.saved() : Promise.resolve(null),
          this.system.read()
        ])
      )
      return this.observedStatus(saved, systemPtyLimit, daemonNonce)
    })
  }

  save(
    maximum: number,
    isCurrent: () => boolean,
    daemonNonce = '',
    deadline = Date.now() + 2_000
  ): Promise<TerminalLimitStatus> {
    return withPolicyOperation(isCurrent, deadline, async (operation) => {
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
          staging = rename
          return rename
        })
        if (!replaced) {
          throw new Error('Terminal host changed')
        }
        // Drain pre-replacement observations without evicting their raw I/O.
        await operation.wait(() => this.saved().catch(() => null))
        const saved = await operation.wait(() => this.saved())
        return this.observedStatus(saved, systemPtyLimit, daemonNonce)
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
