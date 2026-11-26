import { GitBranch, MessageSquarePlus } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { colors } from '../theme/mobile-theme'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import type { RouteHandoff } from '../navigation/route-handoff'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { MobileAgentSessionHistoryIcon } from './MobileAgentSessionHistoryIcon'
import { translate } from '../i18n/mobile-i18n'
import { readAgentLaunchSupport } from '../session/agent-launch/agent-launch-request'
import { AI_VAULT_SESSION_HANDOFF_RUNTIME_CAPABILITY } from '../../../src/shared/ai-vault/contracts/ai-vault-runtime-capabilities'

type Args = {
  hostId: string
  worktreeId: string
  worktreeName: string
  /** The row's server when it runs on one, so the opened screen works there; null when unreachable. */
  executionHost?: ExecutionHostId | null
  hostCapabilities: readonly string[]
  navigate: (target: string) => void
  onDone: () => void
}

export function openHistorySession(
  router: RouteHandoff,
  origin: string | undefined,
  hostId: string,
  fromWorktreeId: string,
  toWorktreeId: string,
  name?: string,
  executionHost?: ExecutionHostId | null,
  currentExecutionHost?: ExecutionHostId | null
): void {
  // Why both hosts: the same worktree can resume on another machine.
  if (
    origin === 'session' &&
    toWorktreeId === fromWorktreeId &&
    (executionHost ?? null) === (currentExecutionHost ?? null)
  ) {
    router.back()
    return
  }
  const query = name === undefined ? '' : `?name=${encodeURIComponent(name)}`
  const href = workspaceRouteHref(
    `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(toWorktreeId)}${query}`,
    executionHost
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Expo Router's typed Href union does not model the optional name and executionHost query on this session route.
  router.replace(href as Parameters<RouteHandoff['replace']>[0])
}

// Why: builds the per-worktree "navigate to a screen" action-sheet actions
// (Source Control + Agent Session History). The Agent Session History action is
// included only on hosts advertising the aiVault.v1 capability, so we never
// navigate to a screen that would call a missing RPC method. Extracted from the
// host index action sheet to keep that file under its max-lines budget.
export function buildWorktreeNavigationActions(args: Args): ActionSheetAction[] {
  if (args.executionHost === null) {
    return []
  }
  const executionHost = args.executionHost
  const actions: ActionSheetAction[] = [
    {
      id: 'sourceControl',
      label: translate('agentHistory.worktreeNavigationActions.sourceControl', 'Source Control'),
      icon: GitBranch,
      onPress: () => {
        const params = new URLSearchParams({ name: args.worktreeName, origin: 'host' })
        args.navigate(
          workspaceRouteHref(
            `/h/${encodeURIComponent(args.hostId)}/source-control/${encodeURIComponent(args.worktreeId)}?${params.toString()}`,
            executionHost
          )
        )
        args.onDone()
      }
    }
  ]
  if (!args.hostCapabilities.includes(MOBILE_AI_VAULT_CAPABILITY)) {
    return actions
  }
  // Shipped native routes forward only name and origin to the page, so the picking mode rides on origin.
  const openHistory = (origin?: 'handoff') => {
    const params = new URLSearchParams({ name: args.worktreeName, ...(origin ? { origin } : {}) })
    args.navigate(
      workspaceRouteHref(
        `/h/${encodeURIComponent(args.hostId)}/agent-history/${encodeURIComponent(args.worktreeId)}?${params.toString()}`,
        executionHost
      )
    )
    args.onDone()
  }
  actions.push({
    id: 'agentSessionHistory',
    label: translate(
      'agentHistory.worktreeNavigationActions.agentSessionHistory',
      'Agent Session History'
    ),
    renderIcon: () =>
      MobileAgentSessionHistoryIcon({ size: 16, color: colors.textSecondary, strokeWidth: 2 }),
    onPress: () => openHistory()
  })
  // History picks the session to hand off; the new agent starts through the host's durable launch.
  const launch = readAgentLaunchSupport(args.hostCapabilities)
  if (
    launch &&
    launch.replay &&
    args.hostCapabilities.includes(AI_VAULT_SESSION_HANDOFF_RUNTIME_CAPABILITY)
  ) {
    actions.push({
      id: 'handoffAgentSession',
      label: translate('agentHistory.handoff.title', 'Hand off to agent'),
      icon: MessageSquarePlus,
      onPress: () => openHistory('handoff')
    })
  }
  return actions
}
