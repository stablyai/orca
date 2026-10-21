/**
 * The WSL move driver's production ports: the profile store, the runtime's live terminals, the hook
 * server's agent status, the daemon, the window and the distro's WSL host. Built per call, and only
 * after the internal WSL hosts gate is checked.
 */
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { encodePairingOffer } from '../../shared/pairing'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { findWslHostDeployment } from '../../shared/runtime-environment-wsl-host-store'
import {
  WSL_MOVE_PROGRESS_CHANNEL,
  type WslMoveProgressEvent
} from '../../shared/wsl-move/wsl-move-driver-types'
import { agentHookServer } from '../agent-hooks/server'
import { getDaemonHistoryDir } from '../daemon/daemon-launch-paths'
import {
  countInProcessFallbackTerminals,
  listLiveDaemonSessions
} from '../daemon/daemon-provider-state'
import { HistoryReader } from '../daemon/history-reader'
import { orcadMigrationDestinationFor } from '../managed-server/lifecycle/orcad-runtime-conversion-wiring'
import type { Store } from '../persistence'
import { exportWslMoveManifest } from '../persistence/moving-wsl-projects/wsl-move-manifest-export'
import { runGatedWslMoveDesktopRewritePass } from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite'
import type {
  WslMoveDriverDeps,
  WslMoveHost
} from '../persistence/moving-wsl-projects/wsl-move-driver-ports'
import { proveWslMoveTerminalsExited } from '../persistence/moving-wsl-projects/wsl-move-exit-proof'
import {
  collectWslMoveGateInputs,
  listWslMovePanes,
  type WslMoveGateFactSources
} from '../persistence/moving-wsl-projects/wsl-move-gate-facts'
import { scheduleWslMoveRewriteRetry } from '../persistence/moving-wsl-projects/wsl-move-rewrite-retry'
import { captureWslMoveRestoreHints } from '../persistence/moving-wsl-projects/wsl-move-restore-hints'
import {
  isWslMoveProjectFenced,
  wslMoveProjectRefForWorkspace
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { buildWslMoveShellHistoryBlobs } from '../persistence/moving-wsl-projects/wsl-move-shell-history-blobs'
import { inspectPtyProviderProcessForRenderer } from '../providers/pty-process-inspection'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  commitRemoteOrcadMigrationCatalog,
  listRemoteOrcadRepositories,
  stageRemoteOrcadMigrationBlobChunk
} from '../ssh/orcad-migration-catalog-client'
import { listRemoteOrcadFolderCatalog } from '../ssh/orcad-server-folder-workspaces'
import { makeTerminalScrollbackSnapshotRef } from '../terminal-scrollback-snapshots'
import { requestWorktreeSleepFromRenderer } from '../window/worktree-sleep-request-relay'
import { getWslHostService } from '../wsl/wsl-host-service-instance'
import { defaultWslOrcadEnvironmentId } from '../wsl/wsl-orcad-deploy'
import { tryGetProviderForPty } from './pty/provider/registry'
import { getRuntimeEnvironmentStatus } from './runtime-environments/runtime-environment-status-probe'
import { getTrustedUIRendererWindow } from './ui'

export function createWslMoveDriverDeps(
  store: Store,
  runtime: OrcaRuntimeService
): WslMoveDriverDeps {
  const userDataPath = app.getPath('userData')
  const facts: WslMoveGateFactSources = {
    listTerminals: (workspaceIds) => runtime.listWslMoveLiveTerminals(workspaceIds),
    inspect: async (ptyId) => {
      const provider = tryGetProviderForPty(ptyId)
      if (!provider) {
        throw new Error('terminal_gone')
      }
      return inspectPtyProviderProcessForRenderer(provider, ptyId, { scanChildProcesses: true })
    },
    agentRows: (paneKey) => agentHookServer.getStatusSnapshotForPane(paneKey),
    scrollbackBytes: async (tabId, leafId) =>
      (await store.statTerminalScrollbackSnapshotSize(
        makeTerminalScrollbackSnapshotRef(tabId, leafId)
      )) ?? 0,
    automationRuns: () => store.listAutomationRuns(),
    dispatches: () =>
      (runtime.getExistingOrchestrationDb()?.listLegacyWorkerTerminalRecoveryRows() ?? []).map(
        (row) => ({
          dispatchId: row.dispatch_id,
          worktreeId: row.worktree_id,
          state: row.worker_state
        })
      )
  }
  return {
    userDataPath,
    readCatalog: () => ({
      repos: store.getRepos(),
      folderWorkspaces: store.getFolderWorkspaces(),
      projectGroups: store.getProjectGroups()
    }),
    connectHost: (distro) => connectWslMoveHost(userDataPath, distro),
    exportManifest: (request) => exportWslMoveManifest(store, request),
    gateInputs: (scope) => collectWslMoveGateInputs(facts, scope),
    listPanes: (scope) => listWslMovePanes(facts, scope),
    quiesce: {
      sleepWorkspaces: (workspaceIds) => {
        const window = getTrustedUIRendererWindow()
        if (!window) {
          return Promise.reject(new Error('renderer_unavailable'))
        }
        return requestWorktreeSleepFromRenderer(window, workspaceIds)
      },
      livePtyIds: (workspaceIds) =>
        runtime.listWslMoveLiveTerminals(workspaceIds).map((terminal) => terminal.ptyId),
      captureRestoreHints: (panes, distro) =>
        captureWslMoveRestoreHints(new HistoryReader(getDaemonHistoryDir()), panes, distro),
      proveExited: async (scope) => {
        const fallback = await countInProcessFallbackTerminals()
        return proveWslMoveTerminalsExited(
          {
            listSessions: listLiveDaemonSessions,
            countFallbackSessions: () => fallback,
            isScopeFenced: () =>
              [...scope.workspaceKeys].every((key) =>
                isWslMoveProjectFenced(store, wslMoveProjectRefForWorkspace(key))
              )
          },
          scope
        )
      }
    },
    snapshots: store,
    shellHistory: (distro, worktrees) => buildWslMoveShellHistoryBlobs({ distro, worktrees }),
    // The window reload is the renderer's (`reloadRequired`), through restart preparation.
    finishOnDesktop: async () => {
      await runGatedWslMoveDesktopRewritePass({ userDataPath })
      // A step the host could not take yet (automations back on) retries in this run too.
      scheduleWslMoveRewriteRetry(userDataPath)
    },
    progress: (event: WslMoveProgressEvent) => {
      const window = getTrustedUIRendererWindow()
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(WSL_MOVE_PROGRESS_CHANNEL, event)
      }
    },
    newMigrationId: () => randomUUID(),
    now: () => new Date()
  }
}

async function connectWslMoveHost(
  userDataPath: string,
  distro: string
): Promise<WslMoveHost | null> {
  const service = getWslHostService()
  const environmentId = defaultWslOrcadEnvironmentId(distro)
  if (!service?.recordForEnvironment(environmentId)) {
    return null
  }
  await service.ensureForRuntimeCall(environmentId)
  const environment = resolveEnvironment(userDataPath, environmentId)
  const status = await getRuntimeEnvironmentStatus(userDataPath, environmentId)
  if (!status.ok) {
    return null
  }
  const pairingCode = encodePairingOffer(getPreferredPairingOffer(environment))
  const options = environment.runtimeId ? { expectedRuntimeId: environment.runtimeId } : {}
  const distroGuid = findWslHostDeployment(userDataPath, environmentId)?.distroId ?? undefined
  return {
    environmentId,
    name: environment.name,
    ...(distroGuid ? { distroGuid } : {}),
    capabilities: status.result.capabilities ?? [],
    catalog: orcadMigrationDestinationFor(environment),
    commitWithBlobs: (manifest, expectedBlobs) =>
      commitRemoteOrcadMigrationCatalog(pairingCode, manifest, { ...options, expectedBlobs }),
    blobs: {
      stageChunk: (request) => stageRemoteOrcadMigrationBlobChunk(pairingCode, request, options)
    },
    readHolding: async () => {
      const [repositories, folders] = await Promise.all([
        listRemoteOrcadRepositories(pairingCode, options),
        listRemoteOrcadFolderCatalog(pairingCode, options)
      ])
      return {
        repoIds: repositories.map((repo) => repo.id),
        folderWorkspaceIds: folders.folderWorkspaces.map((folder) => folder.id),
        // The host keeps no per-distro generation it can report yet.
        highestGeneration: 0
      }
    }
  }
}
