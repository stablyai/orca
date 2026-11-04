import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { SurfaceKey } from '../../shared/workspace-surfaces/surface-content'
import type { WorkspaceSurfaceReader } from '../../shared/workspace-surfaces/surface-reader'
import type { SurfaceStorageCommand } from '../../shared/workspace-surfaces/surface-storage-command'
import { hasClosedTerminalTabRecord } from '../../shared/closed-terminal-tab-tombstones'

type Witness = { valid: boolean; keys: string[] }
type Capture = { registry: SurfaceAdmissionRegistry; witness: Witness }
const captures = new WeakMap<object, Capture>()
const registries = new WeakMap<WorkspaceSurfaceReader, SurfaceAdmissionRegistry>()
const keyOf = (key: SurfaceKey) => JSON.stringify([key.hostId, key.workspaceId, key.hostTabId])

/** Only outstanding invocations own entries; completed closes leave no per-key epoch. */
export class SurfaceAdmissionRegistry {
  private readonly pending = new Map<string, Set<Witness>>()

  capture(keys: readonly SurfaceKey[], valid: boolean): Witness {
    const witness: Witness = { valid, keys: [...new Set(keys.map(keyOf))] }
    for (const key of witness.keys) {
      const pending = this.pending.get(key) ?? new Set<Witness>()
      pending.add(witness)
      this.pending.set(key, pending)
    }
    return witness
  }

  invalidate(keys: readonly SurfaceKey[]): void {
    for (const key of keys) {
      for (const witness of this.pending.get(keyOf(key)) ?? []) {
        witness.valid = false
      }
    }
  }

  release(witness: Witness): void {
    for (const key of witness.keys) {
      const pending = this.pending.get(key)
      pending?.delete(witness)
      if (pending?.size === 0) {
        this.pending.delete(key)
      }
    }
  }

  get size(): number {
    return new Set([...this.pending.values()].flatMap((pending) => [...pending])).size
  }
}

export function surfaceAdmissionRegistry(reader: WorkspaceSurfaceReader): SurfaceAdmissionRegistry {
  let registry = registries.get(reader)
  if (!registry) {
    registry = new SurfaceAdmissionRegistry()
    registries.set(reader, registry)
  }
  return registry
}

function identity(command: SurfaceStorageCommand): object | undefined {
  return command.type === 'layout' || command.type === 'replace' || command.type === 'move'
    ? command.request
    : undefined
}

export function captureSurfaceAdmission(
  reader: WorkspaceSurfaceReader,
  command: SurfaceStorageCommand,
  sessions: readonly WorkspaceSessionState[] = command.type === 'layout' ? [command.session] : []
): void {
  const id = identity(command)
  if (!id || !reader.initialized(command.hostId)) {
    return
  }
  const previous = captures.get(id)
  const registry = surfaceAdmissionRegistry(reader)
  if (previous?.registry === registry) {
    return
  }
  const keys: SurfaceKey[] = []
  let valid = previous?.witness.valid !== false
  if (command.type === 'layout') {
    for (const target of command.request.targets) {
      if (target.expected === null) {
        keys.push({
          hostId: command.hostId,
          workspaceId: target.workspaceId ?? command.request.command.workspace,
          hostTabId: target.hostTabId
        })
      }
    }
    const input = command.request.command
    const rawIds =
      input.type === 'createTerminalTab'
        ? input.tabId
          ? [input.tabId]
          : []
        : input.type === 'applyDefaultTabs'
          ? input.tabs.map((tab) => tab.tabId)
          : []
    valid =
      valid &&
      !rawIds.some((tabId) =>
        sessions.some((session) =>
          hasClosedTerminalTabRecord(
            session.closedTerminalTabTombstonesByTabId,
            tabId,
            input.workspace
          )
        )
      )
  } else if (command.type === 'replace' && command.request.expected === null) {
    keys.push(command.request)
  } else if (command.type === 'move' && command.request.destination.expected === null) {
    keys.push({ hostId: command.hostId, ...command.request.destination })
  }
  if (keys.length || !valid) {
    if (previous) {
      previous.registry.release(previous.witness)
    }
    captures.set(id, { registry, witness: registry.capture(keys, valid) })
  }
}

export function surfaceAdmissionValid(command: SurfaceStorageCommand): boolean {
  const id = identity(command)
  return !id || captures.get(id)?.witness.valid !== false
}

export function releaseSurfaceAdmissions(commands: readonly SurfaceStorageCommand[]): void {
  for (const command of commands) {
    const id = identity(command)
    const capture = id && captures.get(id)
    if (capture) {
      capture.registry.release(capture.witness)
      capture.witness.valid = false
    }
  }
}

/** Snapshot imports publish their actual committed keys before any fallible Store notification. */
export function invalidateImportedSurfaceAdmissions(runtime: {
  workspaceSurfaces?: WorkspaceSurfaceReader
  profileStateAuthority?: { takeSurfaceInvalidations?: () => readonly SurfaceKey[] }
}): void {
  const keys = runtime.profileStateAuthority?.takeSurfaceInvalidations?.() ?? []
  if (runtime.workspaceSurfaces) {
    surfaceAdmissionRegistry(runtime.workspaceSurfaces).invalidate(keys)
  }
}
