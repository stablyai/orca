import { makePaneKey } from '../../../../shared/stable-pane-id'
import { claimRuntimePaneCreate, makePaneSpawnReservationKey } from '../pane/spawn-reservation'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { spawnPtyFromRuntimeController } from './spawn'
import {
  killPtyFromRuntimeController,
  markReversibleStopsFromRuntimeController,
  retireRejectedPtyFromRuntimeController,
  stopAndWaitPtyFromRuntimeController
} from './kill'
import {
  attachPtyFromRuntimeController,
  clearBufferFromRuntimeController,
  confirmForegroundProcessFromRuntimeController,
  getCwdFromRuntimeController,
  getForegroundProcessFromRuntimeController,
  getRendererSerializerGenerationFromRuntimeController,
  getSizeFromRuntimeController,
  hasChildProcessesFromRuntimeController,
  hasPtyFromRuntimeController,
  hasRendererSerializerFromRuntimeController,
  inspectProcessFromRuntimeController,
  listProcessesFromRuntimeController,
  listProcessesWithHostScopeFromRuntimeController,
  probePtyLivenessFromRuntimeController,
  resizePtyFromRuntimeController,
  serializeProviderBufferFromRuntimeController,
  waitForRendererSerializerFromRuntimeController,
  writePtyFromRuntimeController
} from './operations'

export function installPtyRuntimeController(deps: PtyRuntimeControllerDeps): void {
  const { runtime, adoptStablePane, requestSerializedBuffer } = deps

  runtime?.setPtyController({
    claimStablePaneCreate: (args) => {
      const paneKey = makePaneKey(args.tabId, args.leafId)
      const ownerKey = makePaneSpawnReservationKey(args.worktreeId, args.connectionId, paneKey)
      return ownerKey ? claimRuntimePaneCreate(ownerKey) : () => {}
    },
    adoptStablePane,
    spawn: async (args) => spawnPtyFromRuntimeController(deps, args),
    write: (ptyId, data) => writePtyFromRuntimeController(ptyId, data),
    probePtyLiveness: (ptyId) => probePtyLivenessFromRuntimeController(deps, ptyId),
    // Why: subscriber-driven ingestion for daemon sessions no renderer pane
    // ever attached. Local daemon sessions only — SSH panes have their own
    // lease machinery, and the in-process local provider streams without
    // attach. Attach-only and false-on-doubt: never creates or resizes.
    attach: (ptyId) => attachPtyFromRuntimeController(deps, ptyId),
    kill: (ptyId) => killPtyFromRuntimeController(deps, ptyId),
    retireRejectedPty: (ptyId, stopConfirmed) =>
      retireRejectedPtyFromRuntimeController(deps, ptyId, stopConfirmed),
    markReversibleStops: (ptyIds) => markReversibleStopsFromRuntimeController(deps, ptyIds),
    stopAndWait: (ptyId, opts) => stopAndWaitPtyFromRuntimeController(deps, ptyId, opts),
    getForegroundProcess: (ptyId) => getForegroundProcessFromRuntimeController(ptyId),
    inspectProcess: (ptyId) => inspectProcessFromRuntimeController(ptyId),
    confirmForegroundProcess: (ptyId) => confirmForegroundProcessFromRuntimeController(ptyId),
    getCwd: (ptyId) => getCwdFromRuntimeController(ptyId),
    hasChildProcesses: (ptyId) => hasChildProcessesFromRuntimeController(ptyId),
    clearBuffer: (ptyId) => clearBufferFromRuntimeController(deps, ptyId),
    hasPty: (ptyId) => hasPtyFromRuntimeController(ptyId),
    listProcesses: (connectionId, opts) =>
      listProcessesFromRuntimeController(deps, connectionId, opts),
    listProcessesWithHostScope: (opts) =>
      listProcessesWithHostScopeFromRuntimeController(deps, opts),
    serializeBuffer: (ptyId, opts) => {
      // Why: mobile xterm must start from the desktop's exact screen state/dimensions before live TUI chunks render correctly.
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
