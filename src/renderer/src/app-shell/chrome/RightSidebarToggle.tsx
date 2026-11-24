import { SidebarToggleIcon } from '@/components/icons/SidebarToggleIcon'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { keepPaneFocusPressProps } from '@/lib/overlay-interaction/focus-keeping-press'
import { useShortcutLabel } from '../../lib/keyboard/useShortcutLabel'
import { useAppStore } from '../../store'
import { useBotForWorkspace } from '../../components/bots/bot-workspace'
import { useBotNeedsYouCount, useBotNow } from '../../components/bots/use-bot-now'

export function RightSidebarToggle({
  edge = 'right'
}: { edge?: 'left' | 'right' } = {}): React.JSX.Element {
  const t = useTranslate()
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const rightSidebarShortcutLabel = useShortcutLabel('sidebar.right.toggle')
  const open = useAppStore((s) => s.rightSidebarOpen)
  const bot = useBotForWorkspace(useAppStore((s) => s.activeWorktreeId))
  // A bot page's closed panel badges what needs the owner (the open panel's Activity tab counts it); it never opens by itself.
  const shown = open ? null : bot
  const needsYou = useBotNeedsYouCount(shown, useBotNow(shown))
  const needsYouLabel =
    needsYou > 0
      ? t('bots.panel.showNeedYou', 'Show panel · {{count}} need you', {
          count: needsYou,
          defaultValue_one: 'Show panel · {{count}} needs you'
        })
      : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="sidebar-toggle relative mr-2"
          onClick={toggleRightSidebar}
          {...keepPaneFocusPressProps}
          aria-label={
            needsYouLabel ??
            (edge === 'left'
              ? t('menu.toggleLeftSidebar', 'Toggle Left Sidebar')
              : t('auto.App.9e0b441a91', 'Toggle right sidebar'))
          }
        >
          <SidebarToggleIcon side={edge} size={16} />
          {needsYouLabel ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-agent-question px-1 text-3xs font-semibold leading-none text-white tabular-nums ring-2 ring-background"
            >
              {needsYou}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {needsYouLabel ??
          (edge === 'left'
            ? t('auto.App.ce37cf5279', 'Toggle sidebar ({{value0}})', {
                value0: rightSidebarShortcutLabel
              })
            : t('auto.App.c184e056de', 'Toggle right sidebar ({{value0}})', {
                value0: rightSidebarShortcutLabel
              }))}
      </TooltipContent>
    </Tooltip>
  )
}
