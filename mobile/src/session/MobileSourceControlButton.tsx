import { GitBranch } from '../components/icons/app-icons'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { prStateIcon } from '../source-control/review/status/pr-state-token'
import { prStateColor } from '../worktree/row-presentation/WorktreeMetaGlyphs'
import {
  HOST_LIST_TARGET,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../host-screen/catalog/host-list-queries'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useHostQuery } from '../query/host-query'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { UNCACHED_LINKED_PR_STATE } from '../../../src/shared/worktree/catalog/runtime-worktree-contracts'

/** The source-control button's look: the linked PR's state icon and colour, else a plain branch. */
export function useSourceControlButtonLook(hostId: string, worktreeId: string) {
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
  return {
    icon: pr ? prStateIcon(pr.state) : GitBranch,
    color: knownState ? prStateColor(knownState) : undefined
  }
}

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
  const look = useSourceControlButtonLook(hostId, worktreeId)
  return (
    <NavBarButton
      active={active}
      accessibilityLabel={t('session.header.openSourceControl', 'Open source control')}
      icon={look.icon}
      iconColor={look.color}
      onPress={onPress}
    />
  )
}
