import { ArrowLeftRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../store'
import { resolveWorkspaceMode, workspaceModeLayoutBundle } from './workspace-mode'
import {
  chatPanelSideForMode,
  normalizeWorktreeChatSide
} from '../store/slices/tabs/chat-panel-layout'
import { sendLayoutCommandToOwner } from '../runtime/workspace-layout/commands/layout-owner-command'

/**
 * Work/Code mode switch. Work keeps sessions left with chat center; Code keeps
 * Explorer left with editor center and chat right. Each switch restores its
 * fixed panel arrangement instead of just moving one sidebar.
 */
export function SidebarLayoutToggle(): React.JSX.Element {
  const t = useTranslate()
  const mode = useAppStore((s) => resolveWorkspaceMode(s.settings))
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const isCode = mode === 'code'
  const label = isCode
    ? t('app.sidebarLayout.switchToWork', 'Switch to Work mode (sessions left, chat center)')
    : t('app.sidebarLayout.switchToCode', 'Switch to Code mode (Explorer left, chat right)')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={label}
          aria-pressed={isCode}
          onClick={() => {
            const nextMode = isCode ? 'work' : 'code'
            const next = workspaceModeLayoutBundle(nextMode)
            setSidebarOpen(next.sidebarOpen)
            setRightSidebarTab(next.rightSidebarTab)
            setRightSidebarOpen(next.rightSidebarOpen)
            // Why: a mode switch reorders existing columns so Code keeps
            // editor center with chat right instead of leaving chat left.
            // Layout has one runtime owner: send the side per worktree.
            const side = chatPanelSideForMode(nextMode)
            const keep = (): void => {}
            const owner = useAppStore.getState()
            for (const worktreeId of Object.keys(owner.layoutByWorktree)) {
              const normalized = normalizeWorktreeChatSide(
                owner.layoutByWorktree[worktreeId],
                owner.groupsByWorktree[worktreeId],
                nextMode
              )
              if (normalized && normalized !== owner.layoutByWorktree[worktreeId]) {
                sendLayoutCommandToOwner(
                  worktreeId,
                  { type: 'setChatPanelSide', side },
                  { apply: keep, asToday: keep }
                )
              }
            }
            void updateSettings({
              workspaceMode: nextMode,
              toolsSidebarPosition: next.toolsSidebarPosition
            })
          }}
        >
          <ArrowLeftRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
