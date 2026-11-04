import { releaseSurfaceAdmissions } from '../workspace-surfaces/surface-admission-capture'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  capturePersistedTerminalTabCopy,
  isSamePersistedTerminalTabCopy
} from './workspace-session-terminal-tab-retirement-identity'
import { randomUUID } from 'node:crypto'
import { MAX_SURFACE_COMMAND_LIFETIME_MS } from '../workspace-surfaces/surface-command-receipts'
import type { SurfaceStorageMutation } from '../../shared/workspace-surfaces/surface-storage-command'

import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import type { WorkspaceSurfaceReader } from '../../shared/workspace-surfaces/surface-reader'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalSurfaceCloseOptions } from './terminal-surface-close'
import { captureSurfaceLayoutCommand } from '../workspace-surfaces/surface-layout-request'
import { surfaceLayoutOutcome } from '../workspace-surfaces/surface-layout-outcome'

/** Capture the addressed occurrences before queueing; a later close cannot acquire a successor. */
export async function closeCanonicalTerminalSurface(
  store: Pick<
    RuntimeStore,
    | 'captureWorkspaceSurfaceAdmission'
    | 'workspaceSurfacesInitialized'
    | 'readWorkspaceSurfaces'
    | 'readWorkspaceSurfaceFromCatalog'
    | 'executeWorkspaceSurfaceTransaction'
    | 'executeWorkspaceSurfaceCommand'
    | 'getWorkspaceSession'
  >,
  hostIds: readonly ExecutionHostId[],
  worktreeId: string,
  target: TerminalSurfaceCloseTarget,
  options: TerminalSurfaceCloseOptions
): Promise<string[] | null> {
  if (
    !store.workspaceSurfacesInitialized ||
    !store.readWorkspaceSurfaces ||
    !store.executeWorkspaceSurfaceTransaction ||
    !store.getWorkspaceSession ||
    parseExecutionHostId(hostIds[0])?.kind === 'runtime' ||
    !(
      store.workspaceSurfacesInitialized('local') ||
      hostIds.some((hostId) => store.workspaceSurfacesInitialized!(hostId))
    )
  ) {
    return null
  }
  const all = store.readWorkspaceSurfaces.bind(store)
  const host = (id: string) => {
    const parsed = parseExecutionHostId(id)?.id
    if (!parsed) {
      throw new Error('Invalid surface host')
    }
    return parsed
  }
  const reader: WorkspaceSurfaceReader = {
    initialized: (hostId) => store.workspaceSurfacesInitialized!(host(hostId)),
    all: (hostId) => all(host(hostId)),
    read: (key) =>
      store.readWorkspaceSurfaceFromCatalog
        ? store.readWorkspaceSurfaceFromCatalog({ ...key, hostId: host(key.hostId) })
        : (all(host(key.hostId)).find(
            (row) => row.workspaceId === key.workspaceId && row.hostTabId === key.hostTabId
          ) ?? null)
  }
  const owners = hostIds.filter((hostId) => parseExecutionHostId(hostId)?.kind !== 'runtime')
  const capture = (command: SurfaceStorageMutation): SurfaceStorageMutation => {
    store.captureWorkspaceSurfaceAdmission?.(command)
    return command
  }
  const commandForHost = (hostId: ExecutionHostId): SurfaceStorageMutation => {
    const current = reader.read({ hostId, workspaceId: worktreeId, hostTabId: target.tabId })
    // A close arriving before creation still fences a captured late create.
    if (target.kind === 'tab' && !current) {
      if (!options.allowMissing) {
        throw new Error('tab_not_found')
      }
      return capture({
        type: 'replace',
        hostId,
        request: {
          hostId,
          workspaceId: worktreeId,
          hostTabId: target.tabId,
          callerId: 'ordinary-close',
          commandId: randomUUID(),
          expiresAt: Date.now() + MAX_SURFACE_COMMAND_LIFETIME_MS,
          expected: null,
          content: null
        }
      })
    }
    return capture(
      captureSurfaceLayoutCommand(
        reader,
        hostId,
        store.getWorkspaceSession!(hostId),
        target.kind === 'tab'
          ? {
              type: 'closeTabs',
              workspace: worktreeId,
              tabIds: [target.tabId],
              force: options.force,
              recordClose: options.reason === 'user' ? 'user' : 'cleanup'
            }
          : {
              type: 'closePane',
              workspace: worktreeId,
              tabId: target.tabId,
              leafId: target.leafId,
              ...(options.reason !== 'pty-exit' ? { userPaneClose: true as const } : {})
            }
      )
    )
  }
  const captured = new Map<ExecutionHostId, SurfaceStorageMutation>()
  const retainedCapture = (hostId: ExecutionHostId) => {
    let command = captured.get(hostId)
    if (!command) {
      command = commandForHost(hostId)
      captured.set(hostId, command)
    }
    return command
  }
  try {
    for (const hostId of owners) {
      if (reader.initialized(hostId)) {
        retainedCapture(hostId)
      }
    }
    const legacy = new Map(
      owners
        .filter((hostId) => !reader.initialized(hostId))
        .map((hostId) => [
          hostId,
          capturePersistedTerminalTabCopy(
            store.getWorkspaceSession!(hostId),
            worktreeId,
            target.tabId
          )
        ])
    )
    for (const hostId of legacy.keys()) {
      if (!store.executeWorkspaceSurfaceCommand) {
        throw new Error('workspace_session_unavailable')
      }
      await store.executeWorkspaceSurfaceCommand({ type: 'initialize', hostId })
    }
    const commands = owners.map((hostId) => {
      if (
        legacy.has(hostId) &&
        !isSamePersistedTerminalTabCopy(
          legacy.get(hostId) ?? null,
          capturePersistedTerminalTabCopy(
            store.getWorkspaceSession!(hostId),
            worktreeId,
            target.tabId
          )
        )
      ) {
        throw new Error('terminal_pane_owner_changed')
      }
      return retainedCapture(hostId)
    })
    if (commands.length === 0) {
      return []
    }
    const results = await store.executeWorkspaceSurfaceTransaction(() => commands)
    const stopped = new Set<string>()
    for (const result of results) {
      const outcome = result.outcome
      const reply = surfaceLayoutOutcome(outcome)
      if (!reply.ok) {
        if (
          outcome &&
          typeof outcome === 'object' &&
          'status' in outcome &&
          outcome.status === 'conflict' &&
          (outcome.code === 'surface_changed' || outcome.code === 'pane_changed')
        ) {
          throw new Error('terminal_pane_owner_changed')
        }
        if (
          options.allowMissing &&
          ['tab_not_found', 'pane_not_found', 'workspace_not_found'].includes(reply.code)
        ) {
          continue
        }
        throw new Error(
          reply.code === 'tab_not_found' || reply.code === 'pane_not_found'
            ? 'terminal_pane_owner_changed'
            : reply.code
        )
      }
      if (reply.result.refused?.some((entry) => entry.code === 'tab_pinned')) {
        throw new Error('terminal_tab_pinned')
      }
      if (
        outcome &&
        typeof outcome === 'object' &&
        'status' in outcome &&
        outcome.status === 'accepted' &&
        'effects' in outcome
      ) {
        for (const id of outcome.effects.stopPtyIds) {
          stopped.add(id)
        }
      }
    }
    return [...stopped]
  } finally {
    releaseSurfaceAdmissions([...captured.values()])
  }
}
