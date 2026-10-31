import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Progress } from './ui/progress'
import { translate } from '@/i18n/i18n'
import { HOLD_QUIT_DURATION_MS, type HoldQuitNotice as Notice } from '../../../shared/mac-hold-quit'

export function HoldQuitHint({ phase }: { phase: Notice['phase'] }): React.JSX.Element {
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    if (phase !== 'holding') {
      return
    }
    const started = performance.now()
    let frame = 0
    const tick = (): void => {
      const next = Math.min(100, ((performance.now() - started) / HOLD_QUIT_DURATION_MS) * 100)
      setProgress(next)
      if (next < 100) {
        frame = requestAnimationFrame(tick)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [phase])
  const hint = translate('holdQuit.hint', 'Agents are still working. Hold ⌘Q to quit.')
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm">
        {phase === 'unavailable'
          ? translate(
              'holdQuit.unavailable',
              'Hold-to-quit is unavailable. Use the application menu to quit.'
            )
          : hint}
      </p>
      {phase !== 'unavailable' ? (
        <Progress
          value={phase === 'holding' ? progress : 0}
          aria-label={hint}
          animated={false}
          className="h-1.5"
        />
      ) : null}
    </div>
  )
}

export function HoldQuitNotice(): null {
  useEffect(() => {
    const id = 'hold-quit'
    const off = window.api.ui.onHoldQuitNotice?.((notice) => {
      if (notice.phase === 'dismissed') {
        toast.dismiss(id)
      } else {
        toast.message(<HoldQuitHint key={notice.phase} phase={notice.phase} />, {
          id,
          duration: Infinity,
          dismissible: false
        })
      }
    })
    return () => {
      off?.()
      toast.dismiss(id)
    }
  }, [])
  return null
}
