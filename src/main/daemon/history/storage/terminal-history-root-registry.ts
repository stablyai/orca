import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { hasExclusiveOrcadInstanceLock } from '../../../orcad/orcad-instance-lock-hold'
import { TerminalHistoryRoot } from './terminal-history-root'
import type { TerminalHistorySessionWriter } from './terminal-history-session-writer'
import type { ActiveHistoryRecoveryFreeze } from './terminal-history-recovery-quarantine'
import type { ListSessionsResult } from '../../protocol/daemon-rpc-contract'

export type TerminalReservationParticipant = {
  protocolVersion: number
  reservations: () => Promise<ListSessionsResult['reservations'] | null>
}
export type TerminalHistoryMigrationLease = {
  current: () => boolean
  release: () => void
  canceled: Promise<void>
}

export type HistoryParticipant = {
  drain: (id: string) => Promise<unknown>
  freeze: (id: string) => () => void
  retiring?: (id: string) => Promise<unknown>
  writer?: (id: string) => TerminalHistorySessionWriter | ActiveHistoryRecoveryFreeze | undefined
}

const roots = new Map<string, TerminalHistoryRoot>()
const knownPaths = new Map<string, TerminalHistoryRoot>()

export function knownTerminalHistoryRootPath(path: string): string {
  return knownPaths.get(path)?.path ?? resolve(path)
}

export function terminalHistoryRoot(path: string): TerminalHistoryRoot | null {
  return cachedTerminalHistoryRoot(path, (canonical) => new TerminalHistoryRoot(canonical))
}

export function cachedTerminalHistoryRoot(
  path: string,
  create: (canonical: string) => TerminalHistoryRoot
): TerminalHistoryRoot | null {
  const known = knownPaths.get(path)
  if (known) {
    return known
  }
  try {
    // Match asynchronous profile/claim identity, including Windows short-name aliases.
    const canonical = realpathSync.native(path)
    const root = roots.get(canonical) ?? create(canonical)
    roots.set(canonical, root)
    knownPaths.set(path, root)
    return root
  } catch {
    return null
  }
}

export class TerminalHistoryProfile {
  private canonical: string | null = null
  private path: string | null = null
  private binding: Promise<void> | undefined
  runtimeDir: string | null = null
  localReservations: () => Iterable<string> = () => []

  bind(path: string, runtimeDir: string, reservations: () => Iterable<string>): boolean {
    if (this.path === path && this.runtimeDir === runtimeDir) {
      return false
    }
    this.path = path
    this.canonical = null
    this.runtimeDir = runtimeDir
    this.localReservations = reservations
    const binding = realpath(path)
      .then((canonical) => {
        if (this.binding === binding) {
          this.canonical = canonical
        }
      })
      .catch(() => {})
    this.binding = binding
    return true
  }

  async ready(): Promise<void> {
    await this.binding
  }

  matches(canonical: string | undefined): boolean {
    return this.canonical !== null && this.canonical === canonical
  }

  owned(): boolean {
    return this.canonical !== null && hasExclusiveOrcadInstanceLock(this.canonical)
  }
}

export function ownsTerminalHistoryWriter(
  managers: Iterable<HistoryParticipant>,
  id: string,
  writer: TerminalHistorySessionWriter
): boolean {
  return [...managers].every((manager) => {
    const current = manager.writer?.(id)
    return current === undefined || current === writer
  })
}

export function drainRetiredTerminalHistoryManagers(
  managers: Iterable<HistoryParticipant>,
  id: string,
  except: HistoryParticipant
): Promise<unknown[]> | undefined {
  const pending = [...managers]
    .filter((manager) => manager !== except)
    .flatMap((manager) => (manager.retiring ? [manager.retiring(id)] : []))
  return pending.length ? Promise.all(pending) : undefined
}
