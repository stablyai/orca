/**
 * The move orchestrator's production ports and IPC (D3a). Dark: with the internal WSL hosts gate
 * closed, or until a WSL host service exists, nothing is constructed and the IPC answers empty.
 * Automatic starts also stop when ORCA_WSL_MOVE_AUTO=0; explicit user actions still run.
 */
import { app, ipcMain, type WebContents } from 'electron'
import {
  WSL_MOVE_CUTOVER_PHASES,
  wslMoveJournalKey
} from '../../../shared/wsl-move/wsl-move-cutover'
import {
  WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL,
  type WslMoveOrchestratorRecord,
  type WslMoveOrchestratorUserAction
} from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import type { Store } from '../../persistence/loading-store/store'
import { listWslMoveCutoverChain } from '../../persistence/moving-wsl-projects/cutover-recovery/wsl-move-cutover-journal'
import { moveProjectsToWslHost } from '../../persistence/moving-wsl-projects/wsl-move-driver'
import { previewWslMove } from '../../persistence/moving-wsl-projects/execution/wsl-move-driver-preview'
import { wslMoveDistroMappedDrivesLastKnown } from './wsl-move-mapped-drive-ports'
import { onNextWslMappedDriveAnswer } from '../../wsl/filesystem/wsl-mapped-drive-last-known'
import { wslMovedDistroVerdict } from '../../persistence/moving-wsl-projects/quiescence/wsl-move-moved-distro-check'
import { WslMoveOrchestrator } from '../../persistence/moving-wsl-projects/wsl-move-orchestrator'
import type {
  WslMoveFinishedMove,
  WslMoveHostReadiness
} from '../../persistence/moving-wsl-projects/orchestration/wsl-move-orchestrator-ports'
import { prepareWslMoveHost } from '../../persistence/moving-wsl-projects/quiescence/wsl-move-host-readiness'
import { readConfirmedRunningWslDistros } from '../../wsl/discovery/wsl-background-distro-gate'
import { defaultWslOrcadEnvironmentId } from '../../wsl/orcad/wsl-orcad-deploy'
import { createWslMoveOrchestratorStore } from '../../persistence/moving-wsl-projects/orchestration/wsl-move-orchestrator-store'
import type { WslMoveDriverDeps } from '../../persistence/moving-wsl-projects/execution/wsl-move-driver-ports'
import {
  trackWslMoveOrchestrator,
  wslMoveOrchestratorEventProps
} from '../../telemetry/wsl-move-orchestrator-telemetry'
import { runTrackedWslMove } from '../../telemetry/wsl-move-telemetry'
import { readWslDistroRegistrations } from '../../wsl/discovery/wsl-distro-registry-id'
import {
  wslHostsAcceptNewWork,
  wslHostsGateOpen,
  wslHostsOptedIn
} from '../../wsl/host-lifecycle/wsl-host-gate'
import { wslHostAddRefusal } from '../../wsl/host-lifecycle/wsl-host-add-admission'
import { runAsWslUserAct } from '../../wsl/filesystem/wsl-unc-access-gate'
import { getWslHostService } from '../../wsl/host-lifecycle/wsl-host-service-instance'
import { onWslHostUserAction } from '../../wsl/host-lifecycle/wsl-host-user-actions'
import { getTrustedUIRendererWebContents, getTrustedUIRendererWindow } from '../ui'
import { onWslMoveReleasedByUser, releaseWslMoveChainHere } from './wsl-move-release-here'
import { createWslMoveUndoPorts } from './wsl-move-undo-wiring'
import { isDistroInUse } from '../../persistence/moving-wsl-projects/quiescence/wsl-move-distro-in-use'
import { answerWslMoveSleptPanes, requestSleptPanes } from './wsl-move-orchestrator-slept-panes'
import { wslHostRemovalPending } from './wsl-move-host-connect'
import { wslMoveAutoMovesBridgeProjects } from '../../../shared/wsl-move/wsl-move-rollout-stage'
import {
  currentWslMoveOrchestrator,
  noteWslMoveProjectOpened,
  startWslMoveOrchestratorWithHostService
} from './wsl-move-orchestrator-start'

export const WSL_MOVE_ORCHESTRATOR_AUTO_ENV = 'ORCA_WSL_MOVE_AUTO'

export const WSL_MOVE_ORCHESTRATOR_HANDLER_CHANNELS = [
  'wslMoveOrchestrator:list',
  'wslMoveOrchestrator:projectOpened',
  'wslMoveOrchestrator:userAction',
  'wslMoveOrchestrator:answerSleptPanes'
] as const

const COMMITTED_FROM = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')
const USER_ACTIONS: readonly WslMoveOrchestratorUserAction[] = ['retry', 'not-now', 'restore']

function finishedWslMove(userDataPath: string, distro: string): WslMoveFinishedMove | null {
  const move = listWslMoveCutoverChain(userDataPath, wslMoveJournalKey(distro)).findLast(
    (cutover) => WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) >= COMMITTED_FROM
  )
  if (!move) {
    return null
  }
  const { distroGuid } = move.manifest.source
  return distroGuid
    ? { migrationId: move.migrationId, distroGuid }
    : { migrationId: move.migrationId }
}

function isHostReady(distro: string): boolean {
  const key = wslMoveJournalKey(distro)
  return (
    getWslHostService()
      ?.getStatuses()
      .some((status) => wslMoveJournalKey(status.distro) === key && status.state === 'ready') ??
    false
  )
}

function prepareHost(
  userDataPath: string,
  distro: string,
  stillWanted: () => boolean
): Promise<WslMoveHostReadiness> {
  const service = getWslHostService()
  if (!service) {
    return Promise.resolve('failed')
  }
  const environmentId = defaultWslOrcadEnvironmentId(distro)
  return prepareWslMoveHost(
    {
      readRunningDistros: readConfirmedRunningWslDistros,
      isHostReady,
      removalPending: async () => await wslHostRemovalPending(userDataPath, distro),
      hasHost: async () => (await service.recordForEnvironment(environmentId)) !== null,
      connect: () => service.connect(environmentId),
      // Re-checked here: a block learned after the step began must still stop the add.
      add: () =>
        wslHostsAcceptNewWork()
          ? service.add({ distro, startIfStopped: false })
          : Promise.resolve(wslHostAddRefusal('disabled', 'newWorkPaused'))
    },
    distro,
    stillWanted
  )
}

function publish(records: WslMoveOrchestratorRecord[]): void {
  const window = getTrustedUIRendererWindow()
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL, records)
  }
}

function createOrchestrator(
  store: Store,
  driverDeps: () => WslMoveDriverDeps
): WslMoveOrchestrator {
  const userDataPath = app.getPath('userData')
  const sidecar = createWslMoveOrchestratorStore(userDataPath)
  return new WslMoveOrchestrator({
    now: () => Date.now(),
    appVersion: app.getVersion(),
    // A block learned this run, or the setting turned off, stops automatic moves at once.
    autoMoveEnabled: () =>
      process.env[WSL_MOVE_ORCHESTRATOR_AUTO_ENV] !== '0' && wslHostsOptedIn(store.getSettings()),
    autoMovesBridgeProjects: wslMoveAutoMovesBridgeProjects,
    prepareHost: (distro, stillWanted) => prepareHost(userDataPath, distro, stillWanted),
    isDistroInUse: async (distro, check) =>
      await isDistroInUse(store, userDataPath, distro, () =>
        wslMoveDistroMappedDrivesLastKnown(store, distro, check)
      ),
    hostRemovalPending: async (distro) => await wslHostRemovalPending(userDataPath, distro),
    hasHost: async (distro) =>
      (await getWslHostService()?.recordForEnvironment(defaultWslOrcadEnvironmentId(distro))) !=
      null,
    isHostReady,
    preview: async (distro, userAsked) =>
      previewWslMove(
        driverDeps(),
        { distro, sleptPanes: await requestSleptPanes() },
        { settleInterrupted: userAsked ? 'finish-now' : 'finish-at-restart' }
      ),
    start: async (distro, stillWanted, fromPreview) => {
      const sleptPanes = await requestSleptPanes()
      // The user may have released or snoozed the distro while the window answered.
      if (!stillWanted()) {
        return { outcome: 'refused', code: 'wsl_move_cancelled' }
      }
      return runTrackedWslMove(driverDeps(), (deps) =>
        moveProjectsToWslHost(deps, { distro, sleptPanes, ...fromPreview })
      )
    },
    finishedMove: (distro) => finishedWslMove(userDataPath, distro),
    checkMovedDistro: async (distro, move) =>
      wslMovedDistroVerdict(await readWslDistroRegistrations(), distro, move.distroGuid),
    releaseFinishedMove: (distro, unsavedWorkspaceIds) =>
      releaseWslMoveChainHere(userDataPath, distro, unsavedWorkspaceIds, () =>
        createWslMoveUndoPorts(store, userDataPath)
      ),
    load: sidecar.load,
    listKnownDistros: async () =>
      (await readWslDistroRegistrations())?.map((registration) => registration.distro) ?? null,
    save: sidecar.save,
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
    track: (trigger, record, cause) =>
      trackWslMoveOrchestrator(wslMoveOrchestratorEventProps(trigger, record, cause)),
    publish,
    runAsUserAct: runAsWslUserAct
  })
}

/** `driverDeps` is the dialog's driver, but its host connect never boots a stopped distro. */
export function registerWslMoveOrchestrator(
  store: Store,
  driverDeps: () => WslMoveDriverDeps
): void {
  for (const channel of WSL_MOVE_ORCHESTRATOR_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  const isMainWindow = (sender: WebContents | undefined): boolean =>
    !!sender && getTrustedUIRendererWebContents()?.id === sender.id
  // Not setting-gated: a move already in flight when the setting turns off stays visible.
  // Null before construction: the first publish is then the window's snapshot, not a change.
  ipcMain.handle('wslMoveOrchestrator:list', (): WslMoveOrchestratorRecord[] | null =>
    wslHostsGateOpen() ? (currentWslMoveOrchestrator()?.list() ?? null) : []
  )
  // T2: the window opened a bridge project of this distro; the orchestrator checks it is running.
  ipcMain.handle(
    'wslMoveOrchestrator:projectOpened',
    (event: { sender?: WebContents }, distro: unknown): void => {
      // Before construction it is held and replayed: the window sends it once per distro change.
      if (
        wslHostsOptedIn(store.getSettings()) &&
        isMainWindow(event.sender) &&
        typeof distro === 'string'
      ) {
        noteWslMoveProjectOpened(distro)
      }
    }
  )
  ipcMain.handle(
    'wslMoveOrchestrator:userAction',
    async (event: { sender?: WebContents }, request: unknown) => {
      const orchestrator = currentWslMoveOrchestrator()
      if (
        !orchestrator ||
        !wslHostsGateOpen() ||
        !isMainWindow(event.sender) ||
        typeof request !== 'object' ||
        request === null ||
        !('distro' in request) ||
        !('action' in request) ||
        typeof request.distro !== 'string'
      ) {
        return null
      }
      const action = USER_ACTIONS.find((candidate) => candidate === request.action)
      // Retry starts a move; Restore and Not now stay available after a block or with the setting off.
      if (!action || (action === 'retry' && !wslHostsOptedIn(store.getSettings()))) {
        return null
      }
      const unsaved =
        'unsavedWorkspaceIds' in request && Array.isArray(request.unsavedWorkspaceIds)
          ? request.unsavedWorkspaceIds.filter((id): id is string => typeof id === 'string')
          : []
      return orchestrator.userAction(request.distro, action, { unsavedWorkspaceIds: unsaved })
    }
  )
  ipcMain.handle(
    'wslMoveOrchestrator:answerSleptPanes',
    (event: { sender?: WebContents }, request: unknown): void => {
      if (
        !isMainWindow(event.sender) ||
        typeof request !== 'object' ||
        request === null ||
        !('requestId' in request) ||
        typeof request.requestId !== 'string' ||
        !('sleptPanes' in request)
      ) {
        return
      }
      answerWslMoveSleptPanes(request.requestId, request.sleptPanes)
    }
  )
  // Dark: nothing is constructed or read while the gate is closed.
  if (!wslHostsGateOpen()) {
    return
  }
  startWslMoveOrchestratorWithHostService(
    () => createOrchestrator(store, driverDeps),
    (created) => {
      // The constructor adopts the sidecar without publishing; parked or failed records show now.
      publish(created.list())
      onWslMoveReleasedByUser(
        async (distro) => await created.releasedByUser(distro, 'released-here')
      )
      // A Remove is the user declining the host; only their own Add (or Retry) takes it back.
      onWslHostUserAction(async ({ kind, distro }) =>
        kind === 'removed'
          ? await created.releasedByUser(distro, 'removed')
          : created.hostAddedByUser(distro)
      )
      // Once per launch: the first drive answer settled may show a held distro to be unused.
      onNextWslMappedDriveAnswer(() => {
        void created
          .prune()
          .catch((error: unknown) =>
            console.warn('[wsl-move] Could not prune inactive moves', error)
          )
      })
    }
  )
}
