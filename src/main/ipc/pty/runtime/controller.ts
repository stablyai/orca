import { randomUUID } from 'node:crypto'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { AgentExecutionObservationService } from '../../../runtime/agent-execution-observation-service'
import { buildAgentExecutionAttachments } from '../../../runtime/agent-execution-observation-attachments'
import { agentSessionOwners } from '../pane/agent-session-owners'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { getSshPtyProvider } from '../provider/registry'
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
  confirmShellForegroundFromRuntimeController,
  getCwdFromRuntimeController,
  getForegroundProcessFromRuntimeController,
  getRendererSerializerGenerationFromRuntimeController,
  getSizeFromRuntimeController,
  hasChildProcessesFromRuntimeController,
  hasPtyFromRuntimeController,
  hasRendererSerializerFromRuntimeController,
  inspectProcessFromRuntimeController,
  probePtyLivenessFromRuntimeController,
  resizePtyFromRuntimeController,
  serializeProviderBufferFromRuntimeController,
  waitForRendererSerializerFromRuntimeController,
  writePtyAgentSessionProofFromRuntimeController,
  writePtyFromRuntimeController
} from './operations'
import { supportsForegroundProcessEvidenceFromRuntimeController } from './foreground-process-evidence-capability'
import {
  listProcessesFromRuntimeController,
  listProcessesWithHostScopeFromRuntimeController
} from './inventory-operations'

export function installPtyRuntimeController(deps: PtyRuntimeControllerDeps): void {
  const { runtime, adoptStablePane, requestSerializedBuffer } = deps

  const controller = {
    claimStablePaneCreate: (args) => {
      const paneKey = makePaneKey(args.tabId, args.leafId)
      const ownerKey = makePaneSpawnReservationKey(args.worktreeId, args.connectionId, paneKey)
      return ownerKey ? claimRuntimePaneCreate(ownerKey) : () => {}
    },
    adoptStablePane,
    spawn: async (args) => spawnPtyFromRuntimeController(deps, args),
    write: (ptyId, data) => writePtyFromRuntimeController(deps, ptyId, data),
    writeWithSettlement: (ptyId, data) =>
      writePtyFromRuntimeController(deps, ptyId, data, { waitForSettlement: true }),
    writeAgentSessionProof: (ptyId, data, authority) =>
      writePtyAgentSessionProofFromRuntimeController(ptyId, data, authority),
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
    inspectProcess: (ptyId, options) => inspectProcessFromRuntimeController(ptyId, options),
    confirmForegroundProcess: (ptyId) => confirmForegroundProcessFromRuntimeController(ptyId),
    confirmShellForeground: (ptyId) => confirmShellForegroundFromRuntimeController(ptyId),
    getCwd: (ptyId) => getCwdFromRuntimeController(ptyId),
    hasChildProcesses: (ptyId) => hasChildProcessesFromRuntimeController(ptyId),
    clearBuffer: (ptyId) => clearBufferFromRuntimeController(deps, ptyId),
    hasPty: (ptyId) => hasPtyFromRuntimeController(deps, ptyId),
    listProcesses: (connectionId, opts) =>
      listProcessesFromRuntimeController(deps, connectionId, opts),
    listProcessesWithHostScope: (opts) =>
      listProcessesWithHostScopeFromRuntimeController(deps, opts),
    supportsForegroundProcessEvidence: (connectionId) =>
      supportsForegroundProcessEvidenceFromRuntimeController(connectionId),
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
  }
  runtime?.setPtyController(controller)

  if (runtime && deps.publishExecutionObservation) {
    const hostEpochSeed = randomUUID()
    const getHostEpoch = (hostId: ExecutionHostId): string => {
      const parsed = parseExecutionHostId(hostId)
      if (parsed?.kind === 'ssh') {
        const provider = getSshPtyProvider(parsed.targetId)
        const generation =
          provider &&
          'providerGeneration' in provider &&
          typeof provider.providerGeneration === 'number'
            ? provider.providerGeneration
            : null
        if (generation !== null && Number.isSafeInteger(generation) && generation > 0) {
          return `${hostId}:${generation}`
        }
      }
      return `${hostId}:${hostEpochSeed}`
    }
    const previous = observationServicesByRuntime.get(runtime)
    previous?.stop()
    const observationService = new AgentExecutionObservationService(
      {
        getController: (hostId) => (parseExecutionHostId(hostId) ? controller : null),
        getHostEpoch,
        getAttachments: () =>
          buildAgentExecutionAttachments(agentSessionOwners.list(), {
            ptyOwnership,
            ptyIncarnationById,
            getHostEpoch
          }),
        publish: (observation, attachment) => {
          if (attachment?.paneKey) {
            deps.publishExecutionObservation?.(attachment.paneKey, observation, attachment)
          }
        }
      },
      { maxConcurrentHostScans: 2 }
    )
    observationServicesByRuntime.set(runtime, observationService)
    observationService.start()
  }
}

const observationServicesByRuntime = new WeakMap<object, AgentExecutionObservationService>()
