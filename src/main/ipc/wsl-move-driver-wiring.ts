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
import { setDaemonWslSleepCwdReader } from '../daemon/daemon-wsl-sleep-cwd'
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
import {
  classifyWslGuestPaneForeground,
  readWslGuestPaneShellCwd
} from '../persistence/moving-wsl-projects/wsl-move-guest-foreground'
import {
  listWslMoveSleptSessionPanes,
  readWslMoveSleptScrollbackFromHistory,
  withSleptSessionPanes,
  wslMoveTabTitle,
  wslMoveSleptSpoolRoot
} from '../persistence/moving-wsl-projects/wsl-move-slept-scrollback'
import { scheduleWslMoveRewriteRetry } from '../persistence/moving-wsl-projects/wsl-move-rewrite-retry'
import {
  captureWslMoveRestoreHints,
  type WslMoveRestoreHintPane
} from '../persistence/moving-wsl-projects/wsl-move-restore-hints'
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
import { readWslGuestPaneProcesses } from '../wsl/wsl-guest-pane-processes'
import { wslHostsGateOpen } from '../wsl/wsl-host-gate'
import { isWslDistroRegistered } from '../wsl/wsl-distro-registry-id'
import { defaultWslOrcadEnvironmentId } from '../wsl/wsl-orcad-deploy'
import { ptyPaneKey } from './pty/pane/key-state'
import { tryGetProviderForPty } from './pty/provider/registry'
import { getRuntimeEnvironmentStatus } from './runtime-environments/runtime-environment-status-probe'
import { getTrustedUIRendererWindow } from './ui'

/**
 * Lets a sleeping bridge WSL pane keep its shell's folder, so a later move (or wake) reopens it
 * there. Only with the internal WSL hosts gate open, and only on Windows, where the bridge runs.
 */
export function registerWslSleepShellCwdReader(): void {
  if (process.platform !== 'win32' || !wslHostsGateOpen()) {
    return
  }
  setDaemonWslSleepCwdReader(async (sessionId, distro) => {
    const paneKey = ptyPaneKey.get(sessionId)
    const rows = paneKey ? await readWslGuestPaneProcesses(distro) : null
    return paneKey && rows ? readWslGuestPaneShellCwd(rows, paneKey) : null
  })
}

/** Each live bridge pane's shell folder, one process read per distro. */
async function readWslMovePaneShellCwds(
  panes: readonly WslMoveRestoreHintPane[]
): Promise<Map<string, string>> {
  const cwds = new Map<string, string>()
  const distros = new Set(panes.flatMap((pane) => (pane.wslDistro ? [pane.wslDistro] : [])))
  for (const distro of distros) {
    const rows = await readWslGuestPaneProcesses(distro)
    for (const pane of panes) {
      const cwd =
        rows && pane.wslDistro === distro ? readWslGuestPaneShellCwd(rows, pane.paneKey) : null
      if (cwd) {
        cwds.set(pane.paneKey, cwd)
      }
    }
  }
  return cwds
}

export function createWslMoveDriverDeps(
  store: Store,
  runtime: OrcaRuntimeService
): WslMoveDriverDeps {
  const userDataPath = app.getPath('userData')
  const facts: WslMoveGateFactSources = {
    listTerminals: (workspaceIds) => runtime.listWslMoveLiveTerminals(workspaceIds),
    paneKeyForPty: (ptyId) => ptyPaneKey.get(ptyId) ?? null,
    inspect: async (ptyId) => {
      const provider = tryGetProviderForPty(ptyId)
      if (!provider) {
        throw new Error('terminal_gone')
      }
      // After a relaunch, a pane the window has not reopened is still live in the daemon.
      return inspectPtyProviderProcessForRenderer(provider, ptyId, {
        scanChildProcesses: true,
        includeUnattached: true
      })
    },
    agentRows: (paneKey) => agentHookServer.getStatusSnapshotForPane(paneKey),
    ...(process.platform === 'win32'
      ? {
          guestForegrounds: async (distro: string, paneKeys: readonly string[]) => {
            const rows = await readWslGuestPaneProcesses(distro)
            if (!rows) {
              console.warn('[wsl-move] Could not list processes in', distro)
              return new Map()
            }
            return new Map(
              paneKeys.map((key) => {
                const verdict = classifyWslGuestPaneForeground(rows, key)
                if (verdict === 'unverifiable') {
                  // awin verify-5: a pane stayed "cannot check" after its job was killed elsewhere.
                  const tagged = rows.filter((row) => row.paneKey === key)
                  const processes =
                    tagged.map((row) => `${row.pid}/${row.ppid}/${row.comm}`).join(' ') || 'none'
                  console.warn(`[wsl-move] No shell found for a pane; its processes: ${processes}`)
                }
                return [key, verdict]
              })
            )
          }
        }
      : {}),
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
    isDistroRegistered: (distro, distroGuid) => isWslDistroRegistered(distro, distroGuid),
    exportManifest: (request) => exportWslMoveManifest(store, request),
    gateInputs: (scope) => collectWslMoveGateInputs(facts, scope),
    listPanes: (scope) => listWslMovePanes(facts, scope),
    ...(process.platform === 'win32' ? { shellCwds: readWslMovePaneShellCwds } : {}),
    sleptSessionPanes: (workspaceIds, reported) =>
      listWslMoveSleptSessionPanes(store.getWorkspaceSession(), workspaceIds, reported),
    quiesce: {
      sleepWorkspaces: (workspaceIds) => {
        const window = getTrustedUIRendererWindow()
        if (!window) {
          return Promise.reject(new Error('renderer_unavailable'))
        }
        return requestWorktreeSleepFromRenderer(window, workspaceIds, { keepBrowserTabs: true })
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
    sleptScrollback: (panes, distro, migrationId, workspaceIds, reported) =>
      readWslMoveSleptScrollbackFromHistory(
        new HistoryReader(getDaemonHistoryDir()),
        withSleptSessionPanes(
          panes,
          listWslMoveSleptSessionPanes(store.getWorkspaceSession(), workspaceIds, reported)
        ),
        distro,
        wslMoveSleptSpoolRoot(userDataPath, migrationId),
        (tabId) => wslMoveTabTitle(store.getWorkspaceSession(), tabId)
      ),
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
