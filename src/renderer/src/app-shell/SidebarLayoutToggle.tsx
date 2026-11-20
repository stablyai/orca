import { ArrowLeftRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../store'

export function SidebarLayoutToggle(): React.JSX.Element {
  const onLeft = useAppStore((s) => s.settings?.toolsSidebarPosition === 'left')
  const updateSettings = useAppStore((s) => s.updateSettings)
  const label = onLeft
    ? translate('app.sidebarLayout.moveRight', 'Move tools sidebar to the right')
    : translate('app.sidebarLayout.moveLeft', 'Move tools sidebar to the left (VS Code layout)')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={label}
          aria-pressed={onLeft}
          onClick={() => {
            void updateSettings({ toolsSidebarPosition: onLeft ? 'right' : 'left' })
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
