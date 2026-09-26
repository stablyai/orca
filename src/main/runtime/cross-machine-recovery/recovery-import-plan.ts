import type { RecoveryLaunchOverride } from '../../../shared/cross-machine-recovery-launch'
import { createHash } from 'node:crypto'
import {
  getAgentResumeArgv,
  type SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import type { RecoveryBindingKey } from '../../../shared/cross-machine-recovery-binding-key'
import type {
  OrcaRecoveryDescriptorV1,
  RecoveryAgentBinding,
  RecoveryImportBindingResult,
  RecoveryImportIdMap,
  RecoveryLayout,
  RecoveryPathMapping,
  RecoveryPresentationSource,
  RecoveryProviderSession
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
import {
  structuredPlaceholderLeafId,
  withStructuredSessionPlaceholders
} from './recovery-structured-placeholders'

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
  /** Local provider session id → the source id it had before sessionIdMap. */
  sourceProviderSessionIds: ReadonlyMap<string, string>
  recoveryLaunch?: Readonly<Record<string, RecoveryLaunchOverride>>
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
    if (!hostTab) {
      continue
    }
    if (present.has(hostTab.id)) {
      const leafId = binding.sourceLeafId
      const hostLayout = host.terminalLayouts[hostTab.id]
      // Why: a stale view that lost the bound leaf would strand its binding; the host's panes win.
      if (
        leafId &&
        hostLayout &&
        !leafBelongsToTab(next.terminalLayouts, hostTab.id, leafId) &&
        leafBelongsToTab(host.terminalLayouts, hostTab.id, leafId)
      ) {
        next = { ...next, terminalLayouts: { ...next.terminalLayouts, [hostTab.id]: hostLayout } }
      }
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
  layouts: Readonly<Record<string, { root: TerminalPaneLayoutNode | null }>>,
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

export function localRecoveryProviderSession(
  binding: RecoveryAgentBinding,
  pathMap: readonly RecoveryPathMapping[]
): RecoveryProviderSession {
  const transcriptPath = binding.providerSession.transcriptPath
    ? remapRecoveryPath(binding.providerSession.transcriptPath, pathMap)
    : undefined
  return {
    key: binding.providerSession.key,
    id: binding.providerSession.id,
    ...(transcriptPath ? { transcriptPath } : {})
  }
}

/** The binding's identity on this host: its local session id and remapped transcript path. */
export function localRecoveryBindingKey(
  binding: RecoveryAgentBinding,
  pathMap: readonly RecoveryPathMapping[]
): RecoveryBindingKey {
  return { agent: binding.agent, ...localRecoveryProviderSession(binding, pathMap) }
}

export function sourceProviderSessionId(
  binding: RecoveryAgentBinding,
  ctx: Pick<RecoveryPlanContext, 'sourceProviderSessionIds'>
): string {
  return ctx.sourceProviderSessionIds.get(binding.providerSession.id) ?? binding.providerSession.id
}

type RemappedRecoveryPanes = {
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  idMap: RecoveryImportIdMap
}

function mappedPlacement(
  binding: RecoveryAgentBinding,
  remapped: RemappedRecoveryPanes
): { tabId: string; leafId: string } | null {
  const tabId = remapped.idMap.tabs[binding.sourceTabId]
  const sourceLeafId = binding.sourceLeafId ?? structuredPlaceholderLeafId(binding)
  const leafId = sourceLeafId ? remapped.idMap.leaves[sourceLeafId] : undefined
  return tabId && leafId && leafBelongsToTab(remapped.terminalLayoutsByTabId, tabId, leafId)
    ? { tabId, leafId }
    : null
}

/** Each mapped pane goes to one binding: the live one, else the most recently updated. */
function reservePlacements(
  bindings: readonly RecoveryAgentBinding[],
  remapped: RemappedRecoveryPanes
): Map<RecoveryAgentBinding, { tabId: string; leafId: string }> {
  const ranked = [...bindings].sort(
    (a, b) =>
      Number(b.liveness === 'live') - Number(a.liveness === 'live') || b.updatedAt - a.updatedAt
  )
  const taken = new Set<string>()
  const reserved = new Map<RecoveryAgentBinding, { tabId: string; leafId: string }>()
  for (const binding of ranked) {
    const placement = mappedPlacement(binding, remapped)
    const paneKey = placement ? makePaneKey(placement.tabId, placement.leafId) : null
    if (placement && paneKey && !taken.has(paneKey)) {
      taken.add(paneKey)
      reserved.set(binding, placement)
    }
  }
  return reserved
}

/** One dormant origin-'recovery' record per resumable binding, placed on its remapped pane. */
export function planRecoveryBindings(
  bindings: readonly RecoveryAgentBinding[],
  remapped: RemappedRecoveryPanes,
  ctx: RecoveryPlanContext
): PlannedRecoveryBinding[] {
  const reserved = reservePlacements(bindings, remapped)
  return bindings.map((binding) => {
    // Why: an unplaced binding, or one whose source pane another binding holds, gets fresh pane
    // ids; resume creates that tab through placement.
    const { tabId, leafId } = reserved.get(binding) ?? { tabId: ctx.mintId(), leafId: ctx.mintId() }
    const localPaneKey = makePaneKey(tabId, leafId)
    const providerSession = localRecoveryProviderSession(binding, ctx.pathMap)
    const base = {
      sourcePaneKey: binding.sourcePaneKey,
      localPaneKey,
      binding: { agent: binding.agent, ...providerSession },
      sourceProviderSessionId: sourceProviderSessionId(binding, ctx)
    }
    if (getAgentResumeArgv(binding.agent, providerSession) === null) {
      return {
        binding,
        record: null,
        result: { ...base, status: 'refused', reason: 'recovery_session_not_resumable' }
      }
    }
    const launch = ctx.recoveryLaunch?.[sourceProviderSessionId(binding, ctx)]
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
      recovery: {
        importKey: ctx.importKey,
        sourcePaneKey: binding.sourcePaneKey,
        ...(launch ? { appendSystemPrompt: launch.appendSystemPrompt } : {}),
        ...(binding.launch.launchPreferences
          ? { launchPreferences: binding.launch.launchPreferences }
          : {})
      }
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
  const host = withStructuredSessionPlaceholders(descriptor.layout, descriptor.bindings)
  const view =
    selected.layout === descriptor.layout
      ? host
      : withStructuredSessionPlaceholders(selected.layout, descriptor.bindings)
  const layout = withHostBindingTabs(view, host, descriptor.bindings)
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
