import { createHash } from 'node:crypto'
import {
  getAgentResumeArgv,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import type {
  OrcaRecoveryDescriptorV1,
  RecoveryAgentBinding,
  RecoveryImportBindingResult,
  RecoveryImportIdMap,
  RecoveryLayout,
  RecoveryPathMapping,
  RecoveryPresentationSource
} from '../../../shared/cross-machine-recovery-descriptor'
import type { RecoveryWorkspaceFragment } from '../../../shared/cross-machine-recovery-session-ops'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import {
  remapRecoveryLayout,
  remapRecoveryPath,
  type RecoveryRemapContext
} from './recovery-layout-remap'

export type PlannedRecoveryBinding = {
  binding: RecoveryAgentBinding
  record: SleepingAgentSessionRecord | null
  result: RecoveryImportBindingResult
}

export type RecoveryImportPlan = {
  presentationSource: RecoveryPresentationSource
  idMap: RecoveryImportIdMap
  fragment: RecoveryWorkspaceFragment
  bindings: PlannedRecoveryBinding[]
}

export type RecoveryPlanContext = RecoveryRemapContext & {
  importKey: string
  pathMap: readonly RecoveryPathMapping[]
}

const SLEEPING_STATES = new Set(['working', 'blocked', 'waiting', 'done'])

export function computeRecoveryImportKey(descriptor: OrcaRecoveryDescriptorV1): string {
  return createHash('sha256')
    .update(`${descriptor.source.runtimeId}|${descriptor.workspace.instanceId}`)
    .digest('hex')
}

/** Receiving client's own saved view, else the most recently human-used view, else host layout. */
export function selectRecoveryView(
  descriptor: OrcaRecoveryDescriptorV1,
  preferClientInstanceId: string | undefined
): { layout: RecoveryLayout; source: RecoveryPresentationSource } {
  const { views, preferredClientKey } = descriptor.presentation
  const view =
    (preferClientInstanceId
      ? views.find((candidate) => candidate.clientInstanceId === preferClientInstanceId)
      : undefined) ?? views.find((candidate) => candidate.clientKey === preferredClientKey)
  return view
    ? { layout: view.view, source: { kind: 'client-view', clientKey: view.clientKey } }
    : { layout: descriptor.layout, source: { kind: 'host-layout' } }
}

/** Host bindings win over view structure: a bound terminal tab the view lacks comes from the host. */
export function withHostBindingTabs(
  view: RecoveryLayout,
  host: RecoveryLayout,
  bindings: readonly RecoveryAgentBinding[]
): RecoveryLayout {
  if (view === host) {
    return view
  }
  const present = new Set(view.terminalTabs.map((tab) => tab.id))
  const targetGroupId = view.activeGroupId ?? view.groups[0]?.id ?? null
  let next = view
  for (const binding of bindings) {
    const hostTab = host.terminalTabs.find((tab) => tab.id === binding.sourceTabId)
    if (!hostTab || present.has(hostTab.id)) {
      continue
    }
    present.add(hostTab.id)
    const hostUnified = host.tabs.find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === hostTab.id
    )
    const hostLayout = host.terminalLayouts[hostTab.id]
    const hostCwd = host.startupCwdRelative[hostTab.id]
    next = {
      ...next,
      terminalTabs: [...next.terminalTabs, hostTab],
      terminalLayouts: hostLayout
        ? { ...next.terminalLayouts, [hostTab.id]: hostLayout }
        : next.terminalLayouts,
      startupCwdRelative:
        hostCwd === undefined
          ? next.startupCwdRelative
          : { ...next.startupCwdRelative, [hostTab.id]: hostCwd },
      ...(hostUnified && targetGroupId
        ? {
            tabs: [...next.tabs, { ...hostUnified, groupId: targetGroupId }],
            groups: next.groups.map((group) =>
              group.id === targetGroupId
                ? { ...group, tabOrder: [...group.tabOrder, hostUnified.id] }
                : group
            )
          }
        : {})
    }
  }
  return next
}

function leafBelongsToTab(
  layouts: Record<string, TerminalLayoutSnapshot>,
  tabId: string,
  leafId: string
): boolean {
  const stack: (TerminalPaneLayoutNode | null | undefined)[] = [layouts[tabId]?.root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node?.type === 'leaf' && node.leafId === leafId) {
      return true
    }
    if (node?.type === 'split') {
      stack.push(node.first, node.second)
    }
  }
  return false
}

/** One dormant origin-'recovery' record per resumable binding, placed on its remapped pane. */
export function planRecoveryBindings(
  bindings: readonly RecoveryAgentBinding[],
  remapped: {
    terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
    idMap: RecoveryImportIdMap
  },
  ctx: RecoveryPlanContext
): PlannedRecoveryBinding[] {
  return bindings.map((binding) => {
    const mappedTabId = remapped.idMap.tabs[binding.sourceTabId]
    const mappedLeafId = binding.sourceLeafId
      ? remapped.idMap.leaves[binding.sourceLeafId]
      : undefined
    const placed =
      mappedTabId &&
      mappedLeafId &&
      leafBelongsToTab(remapped.terminalLayoutsByTabId, mappedTabId, mappedLeafId)
    // Why: an unplaced binding gets fresh pane ids; resume creates that tab through placement.
    const tabId = placed ? mappedTabId : ctx.mintId()
    const leafId = placed ? mappedLeafId : ctx.mintId()
    const localPaneKey = makePaneKey(tabId, leafId)
    const transcriptPath = binding.providerSession.transcriptPath
      ? remapRecoveryPath(binding.providerSession.transcriptPath, ctx.pathMap)
      : undefined
    const providerSession = {
      key: binding.providerSession.key,
      id: binding.providerSession.id,
      ...(transcriptPath ? { transcriptPath } : {})
    }
    const base = {
      sourcePaneKey: binding.sourcePaneKey,
      localPaneKey,
      providerSessionId: binding.providerSession.id
    }
    if (getAgentResumeArgv(binding.agent, providerSession) === null) {
      return {
        binding,
        record: null,
        result: { ...base, status: 'refused', reason: 'recovery_session_not_resumable' }
      }
    }
    const record: SleepingAgentSessionRecord = {
      paneKey: localPaneKey,
      tabId,
      worktreeId: ctx.worktreeId,
      agent: binding.agent,
      providerSession,
      prompt: binding.prompt ?? '',
      state: SLEEPING_STATES.has(binding.state) ? binding.state : 'done',
      capturedAt: binding.capturedAt > 0 ? binding.capturedAt : ctx.now,
      updatedAt: binding.updatedAt > 0 ? binding.updatedAt : ctx.now,
      ...(binding.terminalTitle ? { terminalTitle: binding.terminalTitle } : {}),
      ...(binding.lastAssistantMessage
        ? { lastAssistantMessage: binding.lastAssistantMessage }
        : {}),
      // Why: source agentArgs/env never cross machines; resume uses this host's defaults.
      launchConfig: { agentArgs: '', agentEnv: {} },
      origin: 'recovery',
      restoreOnTabOpenOnly: false,
      recovery: { importKey: ctx.importKey, sourcePaneKey: binding.sourcePaneKey }
    }
    return { binding, record, result: { ...base, status: 'dormant' } }
  })
}

export function planRecoveryImport(
  descriptor: OrcaRecoveryDescriptorV1,
  preferClientInstanceId: string | undefined,
  ctx: RecoveryPlanContext
): RecoveryImportPlan {
  const selected = selectRecoveryView(descriptor, preferClientInstanceId)
  const layout = withHostBindingTabs(selected.layout, descriptor.layout, descriptor.bindings)
  const remapped = remapRecoveryLayout(layout, ctx)
  return {
    presentationSource: selected.source,
    idMap: remapped.idMap,
    fragment: remapped.fragment,
    bindings: planRecoveryBindings(
      descriptor.bindings,
      { terminalLayoutsByTabId: remapped.fragment.terminalLayoutsByTabId, idMap: remapped.idMap },
      ctx
    )
  }
}
