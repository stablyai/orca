import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { renameFileWithWindowsRetry } from '../../shared/windows-retry-file-operations'
import { isProcessAlive } from './daemon-process-inspection'
import {
  ensureOwnedPrivateDir,
  SHORT_DAEMON_SOCKET_DIR_PREFIX
} from './daemon-socket-endpoint-path'
import {
  parseHostTerminalLedgerEntry,
  sameHostTerminalShare,
  type HostTerminalLedgerEntry,
  type HostTerminalShare
} from './host-terminal-ledger-entry'
import {
  NO_OTHER_AUTOMATIC_WORK,
  recentAutomaticAdmits,
  type OtherAutomaticWork
} from '../../shared/host-automatic-work-budget'

// Why 256: half of macOS's machine-wide pty limit (kern.tty.ptmx_max = 511), so other terminal
// programs and the ptys agents open inside Orca terminals keep room; five times the deleted SSH
// relay's 50, which users with many worktrees did reach.
export const DEFAULT_MAX_HOST_TERMINALS = 256
const MAX_HOST_TERMINALS_ENV_VAR = 'ORCA_DAEMON_MAX_HOST_TERMINALS'
const MAX_OVERRIDE_TERMINALS = 4096

const REFRESH_INTERVAL_MS = 60_000
// Why: a daemon wedged this long is not forking either; its entry must not block others forever.
const STALE_AFTER_MS = 5 * 60_000

export function resolveMaxHostTerminals(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_HOST_TERMINALS_ENV_VAR]?.trim()
  if (!raw || !/^\d+$/.test(raw)) {
    return DEFAULT_MAX_HOST_TERMINALS
  }
  const parsed = Number(raw)
  return parsed >= 1 && parsed <= MAX_OVERRIDE_TERMINALS ? parsed : DEFAULT_MAX_HOST_TERMINALS
}

/** Machine-local and per user: every daemon this user runs on the host, whatever its profile. */
export function defaultHostTerminalLedgerDir(
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.()
): string | null {
  if (platform === 'win32') {
    return join(tmpdir(), 'orca-daemon-host-terminals')
  }
  // Why /tmp, not the data root: a home on a network share can be mounted by several machines.
  return uid === undefined
    ? null
    : posix.join(`${SHORT_DAEMON_SOCKET_DIR_PREFIX}${uid}`, 'terminals')
}

function ensureLedgerDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  const uid = process.getuid?.()
  if (platform === 'win32' || uid === undefined) {
    mkdirSync(dir, { recursive: true })
    return
  }
  // Why validated: the /tmp path is predictable, so a dir another user planted is refused.
  ensureOwnedPrivateDir(posix.dirname(dir), uid)
  ensureOwnedPrivateDir(dir, uid)
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // A leftover entry is ignored once its owner is gone.
  }
}

type HostTerminalLedgerOptions = {
  /** Null keeps the cap to this daemon's own terminals. */
  dir: string | null
  maxTerminals: number
  pid?: number
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
  createDir?: (dir: string) => void
  log: (event: string, details: Record<string, unknown>) => void
}

/** Every other live daemon's share of this host, summed. */
export type OtherDaemonsShare = { terminals: number; automatic: OtherAutomaticWork }

const NO_OTHER_DAEMONS: OtherDaemonsShare = { terminals: 0, automatic: NO_OTHER_AUTOMATIC_WORK }

/**
 * One cap on terminals, and one automatic-restore budget, for the whole execution host. Each
 * daemon owns one file holding its share and sums everyone else's. It writes a terminal
 * reservation before reading the others, so two daemons racing for the last slot cannot both
 * see room. Fail-open: an entry or directory that cannot be read never blocks a terminal.
 */
export class HostTerminalLedger {
  private readonly pid: number
  private readonly now: () => number
  private readonly isAlive: (pid: number) => boolean
  private dirReady = false
  private dirFailed = false
  private published: HostTerminalShare | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: HostTerminalLedgerOptions) {
    this.pid = options.pid ?? process.pid
    this.now = options.now ?? Date.now
    this.isAlive = options.isProcessAlive ?? isProcessAlive
  }

  get maxTerminals(): number {
    return this.options.maxTerminals
  }

  /** `own` excludes the terminal being reserved; on false its previous share is restored. */
  tryReserve(own: HostTerminalShare): boolean {
    if (own.terminals + 1 > this.options.maxTerminals) {
      return false
    }
    this.write({ ...own, terminals: own.terminals + 1 })
    if (own.terminals + 1 + this.readOthers().terminals <= this.options.maxTerminals) {
      return true
    }
    this.write(own)
    return false
  }

  publish(own: HostTerminalShare): void {
    if (this.published === null || !sameHostTerminalShare(own, this.published)) {
      this.write(own)
    }
  }

  start(): void {
    if (this.refreshTimer || this.options.dir === null) {
      return
    }
    this.refreshTimer = setInterval(() => {
      if (this.published !== null) {
        this.write(this.published)
      }
    }, REFRESH_INTERVAL_MS)
    this.refreshTimer.unref?.()
  }

  close(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    const path = this.entryPath()
    if (path) {
      removeQuietly(path)
    }
    this.published = null
  }

  private entryPath(): string | null {
    return this.options.dir === null ? null : join(this.options.dir, `${this.pid}.json`)
  }

  private usableDir(): string | null {
    const dir = this.options.dir
    if (dir === null || this.dirFailed) {
      return null
    }
    if (!this.dirReady) {
      try {
        ;(this.options.createDir ?? ensureLedgerDir)(dir)
        this.dirReady = true
      } catch (error) {
        this.dirFailed = true
        this.options.log('host-terminal-ledger-unavailable', {
          error: error instanceof Error ? error.message : String(error)
        })
        return null
      }
    }
    return dir
  }

  private write(share: HostTerminalShare, retried = false): void {
    this.published = share
    const dir = this.usableDir()
    if (dir === null) {
      return
    }
    const path = join(dir, `${this.pid}.json`)
    const entry: HostTerminalLedgerEntry = {
      schemaVersion: 1,
      pid: this.pid,
      updatedAt: this.now(),
      ...share,
      automaticAdmits: recentAutomaticAdmits(share.automaticAdmits, this.now())
    }
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(entry), { mode: 0o600 })
      renameFileWithWindowsRetry(`${path}.tmp`, path)
    } catch (error) {
      // Why: a periodic /tmp cleaner can remove the directory under a long-lived daemon.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && !retried) {
        this.dirReady = false
        this.write(share, true)
      }
      // Otherwise others undercount this daemon; its own cap still holds.
    }
  }

  readOthers(): OtherDaemonsShare {
    const dir = this.usableDir()
    if (dir === null) {
      return NO_OTHER_DAEMONS
    }
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return NO_OTHER_DAEMONS
    }
    const now = this.now()
    const admits: number[] = []
    const total = { terminals: 0, automatic: { inFlight: 0, live: 0, admits } }
    for (const name of names) {
      const match = /^(\d+)\.json$/.exec(name)
      if (!match || Number(match[1]) === this.pid) {
        continue
      }
      let entry: HostTerminalLedgerEntry | null
      try {
        entry = parseHostTerminalLedgerEntry(readFileSync(join(dir, name), 'utf8'))
      } catch {
        continue
      }
      if (!entry || entry.pid !== Number(match[1])) {
        continue
      }
      if (!this.isAlive(entry.pid)) {
        removeQuietly(join(dir, name))
        continue
      }
      if (now - entry.updatedAt > STALE_AFTER_MS) {
        continue
      }
      total.terminals += entry.terminals
      total.automatic.inFlight += entry.automaticInFlight
      total.automatic.live += entry.automaticLive
      admits.push(...recentAutomaticAdmits(entry.automaticAdmits, now))
    }
    return total
  }
}
