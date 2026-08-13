import type { MouseEventHandler, ReactNode } from 'react'
import { ArrowUp, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type ComposerRunMode = 'send' | 'stop' | 'resume'

export function ComposerRunButton({
  mode,
  label,
  disabled,
  onClick,
  sendIcon
}: {
  mode: ComposerRunMode
  label: string
  disabled: boolean
  onClick?: MouseEventHandler<HTMLButtonElement>
  sendIcon?: ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      data-native-chat-critical-action={mode === 'stop' ? 'stop' : undefined}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      variant={mode === 'stop' ? 'secondary' : 'default'}
      size="icon-sm"
      className="rounded-full pointer-coarse:size-10"
    >
      {mode === 'stop' ? (
        <Square className="size-3.5 fill-current" />
      ) : mode === 'resume' ? (
        <Play className="size-4 fill-current" />
      ) : (
        (sendIcon ?? <ArrowUp className="size-4" />)
      )}
    </Button>
  )
}
