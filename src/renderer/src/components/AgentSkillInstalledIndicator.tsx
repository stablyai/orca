import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

type AgentSkillInstalledIndicatorProps = {
  className?: string
  showLabel?: boolean
}

export function AgentSkillInstalledIndicator({
  className,
  showLabel = true
}: AgentSkillInstalledIndicatorProps): React.JSX.Element {
  return (
    <span
      aria-label="Skill installed"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300',
        className
      )}
    >
      <Check className="size-3.5" aria-hidden />
      {showLabel ? <span>Installed</span> : <span className="sr-only">Installed</span>}
    </span>
  )
}
