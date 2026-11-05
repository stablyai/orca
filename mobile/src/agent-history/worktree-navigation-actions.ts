import { GitBranch } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { colors } from '../theme/mobile-theme'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { MobileAgentSessionHistoryIcon } from './MobileAgentSessionHistoryIcon'
import { translate } from '../i18n/mobile-i18n'

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

// Gate history action on aiVault.v1 so navigation cannot call a missing RPC; actions also include Source Control.
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
  if (args.hostCapabilities.includes(MOBILE_AI_VAULT_CAPABILITY)) {
    actions.push({
      id: 'agentSessionHistory',
      label: translate(
        'agentHistory.worktreeNavigationActions.agentSessionHistory',
        'Agent Session History'
      ),
      renderIcon: () =>
        MobileAgentSessionHistoryIcon({ size: 16, color: colors.textSecondary, strokeWidth: 2 }),
      onPress: () => {
        const params = new URLSearchParams({ name: args.worktreeName })
        args.navigate(
          workspaceRouteHref(
            `/h/${encodeURIComponent(args.hostId)}/agent-history/${encodeURIComponent(args.worktreeId)}?${params.toString()}`,
            executionHost
          )
        )
        args.onDone()
      }
    })
  }
  return actions
}
