import { adoptMaterializedRuntimePtySpawn } from './spawn-early'
import { createRuntimePtySpawnState } from './spawn-state'
import { localProvider } from '../provider/registry'
import {
  getLocalAutomaticWorkStatus,
  localTerminalLimit,
  resumeLocalAutomaticWork
} from '../../../daemon/daemon-automatic-work-resume'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { claimRuntimePaneCreate, makePaneSpawnReservationKey } from '../pane/spawn-reservation'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { spawnPtyFromRuntimeController } from './spawn'
import {
  killPtyFromRuntimeController,
  retireRejectedPtyFromRuntimeController,
  stopAndWaitPtyFromRuntimeController
} from './kill'
import {
  attachPtyFromRuntimeController,
  clearBufferFromRuntimeController,
  resetInputModesFromRuntimeController,
  confirmForegroundProcessFromRuntimeController,
  confirmShellForegroundFromRuntimeController,
  getCwdFromRuntimeController,
  getForegroundProcessFromRuntimeController,
  getRendererSerializerGenerationFromRuntimeController,
  getSizeFromRuntimeController,
  hasChildProcessesFromRuntimeController,
  hasPtyFromRuntimeController,
  getPtyAvailabilityFromRuntimeController,
  hasRendererSerializerFromRuntimeController,
  inspectProcessFromRuntimeController,
  probePtyLivenessFromRuntimeController,
  resizePtyFromRuntimeController,
  serializeProviderBufferFromRuntimeController,
  waitForRendererSerializerFromRuntimeController,
  writePtyFromRuntimeController
} from './operations'
import { supportsForegroundProcessEvidenceFromRuntimeController } from './foreground-process-evidence-capability'
import {
  listProcessesFromRuntimeController,
  listProcessesWithHostScopeFromRuntimeController
} from './inventory-operations'

export function installPtyRuntimeController(deps: PtyRuntimeControllerDeps): void {
  const { runtime, adoptStablePane, requestSerializedBuffer } = deps

  runtime?.setPtyController({
    claimStablePaneCreate: (args) => {
      const paneKey = makePaneKey(args.tabId, args.leafId)
      const ownerKey = makePaneSpawnReservationKey(args.worktreeId, args.connectionId, paneKey)
      return ownerKey ? claimRuntimePaneCreate(ownerKey) : () => {}
    },
    adoptStablePane: async (args) => {
      const adopted = await adoptStablePane(args)
      if (adopted) {
        await adoptMaterializedRuntimePtySpawn(
          createRuntimePtySpawnState(deps, { ...args, adoptedStablePane: adopted })
        )
      }
      return adopted
    },
    spawn: async (args) => spawnPtyFromRuntimeController(deps, args),
    // Local owner only: an SSH host's gate belongs to that host's own runtime.
    terminalLimit: (update) => localTerminalLimit(localProvider, update),
    getAutomaticWorkStatus: () => getLocalAutomaticWorkStatus(localProvider),
    resumeAutomaticWork: () => resumeLocalAutomaticWork(localProvider),
    write: (ptyId, data, inputKind) => writePtyFromRuntimeController(deps, ptyId, data, inputKind),
    writeWithSettlement: (ptyId, data, inputKind) =>
      writePtyFromRuntimeController(deps, ptyId, data, inputKind, { waitForSettlement: true }),
    probePtyLiveness: (ptyId) => probePtyLivenessFromRuntimeController(deps, ptyId),
    // Attach-only ingestion serves unmounted daemon sessions without creating/resizing; SSH uses leases and local PTYs already stream.
    attach: (ptyId) => attachPtyFromRuntimeController(deps, ptyId),
    kill: (ptyId) => killPtyFromRuntimeController(deps, ptyId),
    retireRejectedPty: (ptyId, stopConfirmed, incarnationId) =>
      retireRejectedPtyFromRuntimeController(deps, ptyId, stopConfirmed, incarnationId),
    stopAndWait: (ptyId, opts) => stopAndWaitPtyFromRuntimeController(deps, ptyId, opts),
    getForegroundProcess: (ptyId) => getForegroundProcessFromRuntimeController(ptyId),
    inspectProcess: (ptyId, options) => inspectProcessFromRuntimeController(ptyId, options),
    confirmForegroundProcess: (ptyId) => confirmForegroundProcessFromRuntimeController(ptyId),
    confirmShellForeground: (ptyId) => confirmShellForegroundFromRuntimeController(ptyId),
    getCwd: (ptyId) => getCwdFromRuntimeController(ptyId),
    hasChildProcesses: (ptyId) => hasChildProcessesFromRuntimeController(ptyId),
    clearBuffer: (ptyId) => clearBufferFromRuntimeController(deps, ptyId),
    resetInputModes: (ptyId) => resetInputModesFromRuntimeController(deps, ptyId),
    hasPty: (ptyId) => hasPtyFromRuntimeController(deps, ptyId),
    getPtyAvailability: (ptyId) => getPtyAvailabilityFromRuntimeController(deps, ptyId),
    listProcesses: (hostId, opts) => listProcessesFromRuntimeController(deps, hostId, opts),
    listProcessesWithHostScope: (opts) =>
      listProcessesWithHostScopeFromRuntimeController(deps, opts),
    supportsForegroundProcessEvidence: (hostId) =>
      supportsForegroundProcessEvidenceFromRuntimeController(hostId),
    serializeBuffer: (ptyId, opts) => {
      // Mobile needs exact screen state and geometry before rendering live TUI output.
      return requestSerializedBuffer(ptyId, opts)
    },
    serializeProviderBuffer: (ptyId, opts) =>
      serializeProviderBufferFromRuntimeController(ptyId, opts),
    hasRendererSerializer: (ptyId) => hasRendererSerializerFromRuntimeController(ptyId),
    getRendererSerializerGeneration: (ptyId) =>
      getRendererSerializerGenerationFromRuntimeController(ptyId),
    waitForRendererSerializer: (ptyId, afterGeneration, timeoutMs, signal) =>
      waitForRendererSerializerFromRuntimeController(ptyId, afterGeneration, timeoutMs, signal),
    getSize: (ptyId) => getSizeFromRuntimeController(ptyId),
    resize: (ptyId, cols, rows) => resizePtyFromRuntimeController(ptyId, cols, rows)
  })
}
