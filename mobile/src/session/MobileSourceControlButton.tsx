import { GitBranch } from 'lucide-react-native'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { prStateIcon } from '../components/pr-state-token'
import { prStateColor } from '../components/WorktreeMetaGlyphs'
import {
  HOST_LIST_TARGET,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../host-screen/host-list-queries'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostQuery } from '../query/host-query'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { UNCACHED_LINKED_PR_STATE } from '../../../src/shared/runtime-worktree-contracts'

// Its own component so catalog updates re-render only this button, not the whole session header.
export function MobileSourceControlButton({
  hostId,
  worktreeId,
  active,
  onPress
}: {
  hostId: string
  worktreeId: string
  active: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Cache-only: the host list reads worktree.ps, and a session's first paint must not wait behind it.
  const { data } = useHostQuery(
    hostWorktreeCatalogQuery,
    { hostId, client: null },
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    { enabled: false }
  )
  const pr = data?.worktrees.find((row) => row.worktreeId === worktreeId)?.linkedPR ?? null
  const knownState = pr && pr.state !== UNCACHED_LINKED_PR_STATE ? pr.state : null
  return (
    <NavBarButton
      active={active}
      accessibilityLabel={t('session.header.openSourceControl', 'Open source control')}
      icon={pr ? prStateIcon(pr.state) : GitBranch}
      iconColor={knownState ? prStateColor(knownState) : undefined}
      onPress={onPress}
    />
  )
}
