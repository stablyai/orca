import { surfaceLayoutOutcome } from '../../workspace-surfaces/surface-layout-outcome'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSurfaceReader } from '../../../shared/workspace-surfaces/surface-reader'
import type {
  CommandOf,
  LayoutRefusalCode
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSurfaceCommands } from '../loading-store/workspace-surface-commands'
import type { SessionHostPartitionOperations } from '../loading-store/session-host-partitions'
import type { TerminalPaneAdmission, TerminalPaneAdmissionOutcome } from './terminal-pane-admission'
import { captureSurfaceLayoutCommand } from '../../workspace-surfaces/surface-layout-request'
import type { UnstartedPaneKept } from './unstarted-pane-withdraw'
import {
  runTargetOf,
  sameRunTarget,
  type SurfaceRunTarget
} from '../../../shared/workspace-surfaces/surface-allocation'

type AdmissionContext = {
  surfaces: WorkspaceSurfaceCommands
  reader: WorkspaceSurfaceReader
  sessions: SessionHostPartitionOperations
}

export async function admitCanonicalTerminalPane(
  context: AdmissionContext,
  hostId: ExecutionHostId,
  admission: TerminalPaneAdmission
): Promise<TerminalPaneAdmissionOutcome> {
  return (await admitCanonicalTerminalRun(context, hostId, admission)).outcome
}

export type TerminalRunAdmission = {
  outcome: TerminalPaneAdmissionOutcome
  /** Undefined is a legacy host; null means no canonical run was admitted. */
  target: SurfaceRunTarget | null | undefined
}

export async function admitCanonicalTerminalRun(
  context: AdmissionContext,
  hostId: ExecutionHostId,
  admission: TerminalPaneAdmission,
  expectedSource?: SurfaceRunTarget | null
): Promise<TerminalRunAdmission> {
  const captured = captureSurfaceLayoutCommand(
    context.reader,
    hostId,
    context.sessions.getWorkspaceSession(hostId),
    admission
  )
  let refusal: TerminalPaneAdmissionOutcome = 'tab_not_found'
  const results = await context.surfaces.executeWorkspaceSurfaceTransaction(() => {
    if (expectedSource !== undefined) {
      const source = expectedSource && context.reader.read(expectedSource)
      const current = source && expectedSource ? runTargetOf(source, expectedSource.leafId) : null
      if (!expectedSource || !current || !sameRunTarget(current, expectedSource)) {
        refusal = 'pane_not_found'
        return []
      }
    }
    const previous = context.reader.read({
      hostId,
      workspaceId: admission.workspace,
      hostTabId: admission.tabId
    })
    if (admission.type === 'createTerminalTab' && previous?.content === null) {
      refusal = 'tab_closed'
      return []
    }
    return [{ ...captured, session: context.sessions.getWorkspaceSession(hostId) }]
  })
  const outcome = results[0]?.outcome
  if (
    outcome &&
    typeof outcome === 'object' &&
    'status' in outcome &&
    outcome.status === 'accepted' &&
    'surfaces' in outcome
  ) {
    const surface = results[0]!.host.surfaces.find(
      (candidate) =>
        candidate.workspaceId === admission.workspace &&
        candidate.content?.kind === 'terminal' &&
        (candidate.hostTabId === admission.tabId || candidate.content.entityId === admission.tabId)
    )
    const leafId = admission.type === 'createTerminalTab' ? admission.leafId : admission.newLeafId
    return {
      outcome: outcome.surfaces.length === 0 ? 'exists' : 'admitted',
      target: surface ? runTargetOf(surface, leafId) : null
    }
  }
  if (!outcome) {
    return { outcome: refusal, target: null }
  }
  const failed = surfaceLayoutOutcome(outcome)
  return { outcome: failed.ok ? refusal : failed.code, target: null }
}

export async function withdrawCanonicalTerminalPane(
  context: AdmissionContext,
  hostId: ExecutionHostId,
  pane: CommandOf<'closePane'>,
  stillStarting?: () => boolean,
  expected?: SurfaceRunTarget
): Promise<LayoutRefusalCode | UnstartedPaneKept | null> {
  let refusal: LayoutRefusalCode | UnstartedPaneKept = 'pane_not_found'
  const results = await context.surfaces.executeWorkspaceSurfaceTransaction(() => {
    if (expected) {
      const surface = context.reader.read(expected)
      const current = surface ? runTargetOf(surface, expected.leafId) : null
      if (!current || !sameRunTarget(current, expected)) {
        return []
      }
    }
    const session = context.sessions.getWorkspaceSession(hostId)
    if (stillStarting) {
      if (session.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]) {
        refusal = 'bound'
        return []
      }
      if (stillStarting()) {
        refusal = 'starting'
        return []
      }
    }
    return [captureSurfaceLayoutCommand(context.reader, hostId, session, pane)]
  })
  const outcome = results[0]?.outcome
  if (!outcome) {
    return refusal
  }
  const applied = surfaceLayoutOutcome(outcome)
  return applied.ok ? null : applied.code
}
