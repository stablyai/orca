import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { spawnProcess } from '@orca/process-host'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../shared/process-table-index'
import { parseDaemonPidFile } from '../daemon/daemon-pid-file-parse'
import type { WindowsProcessRow } from '../windows/windows-process-table'
import { ORCAD_LOCK_FILE_NAME, readOrcadInstanceLockRecord } from './orcad-instance-lock'

const ROW_LIMIT = 128
const SNAPSHOT_LIMIT = 12

type CleanupDiagnosticError = Error & {
  code?: unknown
  syscall?: unknown
  path?: unknown
  dest?: unknown
}

function boundedText(value: string, limit = 2_048): string {
  const tail =
    value.length > limit
      ? value.slice(-limit).replace(/^[^\r\n]*(?:\r?\n|$)/u, '[truncated]\n')
      : value
  return tail
    .replace(/\b(?:https?|wss?):\/\/\S+/giu, '[url]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/((?:token|pairingCode|authToken)["'=:\s]+)\S+/giu, '$1[redacted]')
    .slice(-limit)
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: boundedText(String(error)) }
  }
  const details: Record<string, unknown> = { name: error.name, message: boundedText(error.message) }
  const diagnosticError: CleanupDiagnosticError = error
  for (const key of ['code', 'syscall', 'path', 'dest'] as const) {
    const value = diagnosticError[key]
    if (typeof value === 'string') {
      details[key] = boundedText(value)
    }
  }
  return details
}

export class ServeCleanupDiagnostics {
  private readonly events: Record<string, unknown>[] = []
  private readonly snapshots: Record<string, unknown>[] = []
  private readonly known = new Map<number, WindowsProcessRow>()
  private readonly daemonIdentities = new Map<number, number | null>()
  private readonly removed = new Set<string>()
  private readonly listeners: (() => void)[] = []
  private child: ReturnType<typeof spawnProcess> | undefined
  private stderr = (): string => ''
  private readonly launchedAt = Date.now()
  private serveStartedAtMs: number | undefined

  constructor(
    private readonly projectRoot: string,
    private readonly userData: string
  ) {}

  owns(root: string): boolean {
    return root === this.projectRoot || root === this.userData
  }

  observe(child: ReturnType<typeof spawnProcess>, stderr: () => string): void {
    this.child = child
    this.stderr = stderr
    this.note('spawn', { pid: child.pid })
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      this.note('exit', { code, signal })
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void =>
      this.note('close', { code, signal })
    const onError = (error: Error): void => this.note('childError', errorDetails(error))
    child.once('exit', onExit)
    child.once('close', onClose)
    child.once('error', onError)
    this.listeners.push(() => {
      child.off('exit', onExit)
      child.off('close', onClose)
      child.off('error', onError)
    })
    for (const [name, stream] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr]
    ] as const) {
      if (!stream) {
        continue
      }
      for (const milestone of ['end', 'close'] as const) {
        const record = (): void => this.note(`${name}.${milestone}`)
        stream.once(milestone, record)
        this.listeners.push(() => stream.off(milestone, record))
      }
    }
  }

  note(phase: string, details: Record<string, unknown> = {}): void {
    if (this.events.length < 64) {
      this.events.push({ at: Date.now(), phase, ...details })
    }
  }

  async capture(phase: string, root?: string): Promise<void> {
    const snapshot: Record<string, unknown> = {}
    try {
      if (this.snapshots.length >= SNAPSHOT_LIMIT) {
        this.snapshots.shift()
      }
      Object.assign(snapshot, { phase, at: Date.now(), root: this.rootRole(root) })
      this.snapshots.push(snapshot)
      snapshot.child = this.child && {
        pid: this.child.pid,
        killed: this.child.killed,
        exitCode: this.child.exitCode,
        signalCode: this.child.signalCode
      }
      snapshot.daemons = this.readDaemons()
      const lock = readOrcadInstanceLockRecord(join(this.userData, ORCAD_LOCK_FILE_NAME))
      snapshot.instanceLock = lock && {
        pid: lock.pid,
        startedAtMs: lock.startedAtMs,
        role: lock.role
      }
      if (
        lock?.role === 'orcad' &&
        lock.pid === this.child?.pid &&
        lock.startedAtMs !== null &&
        lock.startedAtMs >= this.launchedAt - 1_000
      ) {
        this.serveStartedAtMs ??= lock.startedAtMs
      }
      if (process.platform !== 'win32') {
        snapshot.processEvidence = 'unverifiable: Windows native capture only'
        return
      }
      const table = await import('../windows/windows-process-table')
      // Refuse fallback evidence: the public reader can use CIM without the native binding.
      if (!table.isWindowsProcessTableAvailable()) {
        snapshot.processEvidence = 'unverifiable: native process table unavailable'
        return
      }
      snapshot.nativeReaderAvailable = true
      snapshot.ancestryIsDiagnosticOnly = true
      snapshot.creationTimesAvailable = table.isWindowsProcessStartTimeAvailable()
      const rows = await table.readWindowsProcessTableFresh()
      const index = buildProcessTableIndex(rows)
      const selected = new Map<number, WindowsProcessRow>()
      const verifiedRoots: number[] = []
      for (const pid of [this.child?.pid, ...this.daemonIdentities.keys()]) {
        if (pid === undefined) {
          continue
        }
        const row = index.byPid.get(pid)
        if (!row) {
          continue
        }
        selected.set(pid, row)
        const expected =
          pid === this.child?.pid ? this.serveStartedAtMs : this.daemonIdentities.get(pid)
        if (expected === undefined || expected === null || row.creationTimeMs !== expected) {
          continue
        }
        verifiedRoots.push(pid)
        for (const descendant of collectDescendantsFromIndex(index, pid)) {
          if (selected.size >= ROW_LIMIT) {
            break
          }
          selected.set(descendant.pid, descendant)
        }
      }
      snapshot.verifiedAncestryRoots = verifiedRoots
      for (const row of rows) {
        if (selected.size >= ROW_LIMIT) {
          break
        }
        if (
          this.known.has(row.pid) ||
          row.command.includes(this.userData) ||
          row.command.includes(this.projectRoot)
        ) {
          selected.set(row.pid, row)
        }
      }
      snapshot.processes = [...selected.values()].slice(0, ROW_LIMIT).map((row) => ({
        pid: row.pid,
        ppid: row.ppid,
        name: row.name,
        creationTimeMs: row.creationTimeMs,
        command: boundedText(row.command)
      }))
      snapshot.knownIdentities = [...this.known.values()].map((known) => {
        const current = index.byPid.get(known.pid)
        const verdict =
          known.creationTimeMs === undefined
            ? 'unverifiable'
            : !current
              ? 'exited'
              : current.creationTimeMs === undefined
                ? 'unverifiable'
                : current.creationTimeMs === known.creationTimeMs
                  ? 'live'
                  : 'exited'
        return { pid: known.pid, creationTimeMs: known.creationTimeMs, verdict }
      })
      snapshot.rowsAtLimit = selected.size >= ROW_LIMIT
      for (const row of selected.values()) {
        if (this.known.size >= ROW_LIMIT) {
          break
        }
        if (!this.known.has(row.pid)) {
          this.known.set(row.pid, row)
        }
      }
    } catch (error) {
      snapshot.diagnosticsUnavailable = errorDetails(error)
    } finally {
      snapshot.finishedAt = Date.now()
    }
  }

  private readDaemons(): Record<string, unknown>[] {
    const dir = join(this.userData, 'daemon')
    if (!existsSync(dir)) {
      return []
    }
    return readdirSync(dir)
      .filter((name) => /^daemon-v\d+\.pid$/u.test(name))
      .slice(0, 16)
      .map((name) => {
        try {
          const { buffer } = readNodeFileSyncWithinLimit(join(dir, name), 64 * 1_024, {
            regularFileOnly: true
          })
          const record = parseDaemonPidFile(buffer.toString('utf8'))
          if (
            record &&
            this.daemonIdentities.size < ROW_LIMIT &&
            !this.daemonIdentities.has(record.pid)
          ) {
            this.daemonIdentities.set(record.pid, record.startedAtMs)
          }
          return {
            name,
            pid: record?.pid,
            startedAtMs: record?.startedAtMs,
            entryPath: record?.entryPath && boundedText(record.entryPath),
            parsed: record !== null
          }
        } catch (error) {
          return { name, diagnosticsUnavailable: errorDetails(error) }
        }
      })
  }

  report(phase: string, root?: string, error?: unknown, elapsedMs?: number): void {
    try {
      console.error(
        '[orcad-serve-cleanup]',
        JSON.stringify({
          phase,
          at: Date.now(),
          platform: process.platform,
          arch: process.arch,
          root: this.rootRole(root),
          projectRoot: this.projectRoot,
          userData: this.userData,
          elapsedMs,
          error: error === undefined ? undefined : errorDetails(error),
          events: this.events,
          snapshots: this.snapshots,
          stderrTail: boundedText(this.stderr(), 16_384),
          limitation: 'Process ancestry and survival do not establish directory handle ownership.'
        })
      )
    } catch {
      // Diagnostics must not replace the original cleanup failure.
    }
  }

  rootRemoved(root: string): boolean {
    try {
      this.removed.add(root)
      if (this.removed.size !== 2) {
        return false
      }
      if (
        process.env.ORCA_SERVE_CLEANUP_DIAGNOSTICS === '1' ||
        (process.platform === 'win32' && process.env.CI)
      ) {
        this.report('cleanupComplete')
      }
      for (const remove of this.listeners) {
        remove()
      }
      return true
    } catch {
      return false
    }
  }

  private rootRole(root: string | undefined): string | undefined {
    return root === undefined
      ? undefined
      : root === this.projectRoot
        ? 'projectRoot'
        : root === this.userData
          ? 'userData'
          : 'unregistered'
  }
}
