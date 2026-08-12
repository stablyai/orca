import { GitBranch } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { colors } from '../theme/mobile-theme'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { MobileAgentSessionHistoryIcon } from './MobileAgentSessionHistoryIcon'

type Args = {
  hostId: string
  worktreeId: string
  worktreeName: string
  hostCapabilities: readonly string[]
  navigate: (target: string) => void
  onDone: () => void
}

// Why: builds the per-worktree "navigate to a screen" action-sheet actions
// (Source Control + Agent Session History). The Agent Session History action is
// included only on hosts advertising the aiVault.v1 capability, so we never
// navigate to a screen that would call a missing RPC method. Extracted from the
// host index action sheet to keep that file under its max-lines budget.
export function buildWorktreeNavigationActions(args: Args): ActionSheetAction[] {
  const actions: ActionSheetAction[] = [
    {
      label: 'Source Control',
      icon: GitBranch,
      onPress: () => {
        const params = new URLSearchParams({ name: args.worktreeName, origin: 'host' })
        args.navigate(
          `/h/${args.hostId}/source-control/${encodeURIComponent(args.worktreeId)}?${params.toString()}`
        )
        args.onDone()
      }
    }
  ]
  if (args.hostCapabilities.includes(MOBILE_AI_VAULT_CAPABILITY)) {
    actions.push({
      label: 'Agent Session History',
      renderIcon: () =>
        MobileAgentSessionHistoryIcon({ size: 16, color: colors.textSecondary, strokeWidth: 2 }),
      onPress: () => {
        const params = new URLSearchParams({ name: args.worktreeName })
        args.navigate(
          `/h/${args.hostId}/agent-history/${encodeURIComponent(args.worktreeId)}?${params.toString()}`
        )
        args.onDone()
      }
    })
  }
  return actions
}
