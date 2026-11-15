import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { themeStudioDraftDetail } from './theme-studio-draft-detail'

export type ThemeStudioNoticeProps = {
  name: string
  /** The last change and who made it ("claude · Terminal 2"). */
  label?: string
  by?: string
  autoFixed?: number
  /** Steps since the draft started. */
  changes?: number
  canUndo: boolean
  onKeep: () => void
  onUndo: () => void
  onDiscard: () => void
}

/** The always-visible control over an agent's theme draft: keep it, step back, or drop it. */
export function ThemeStudioNotice({
  name,
  label,
  by,
  autoFixed,
  changes,
  canUndo,
  onKeep,
  onUndo,
  onDiscard
}: ThemeStudioNoticeProps): React.JSX.Element {
  const t = useTranslate()
  const detail = themeStudioDraftDetail({ label, by, autoFixed }, changes, t)
  return (
    <div
      className="w-[24rem] max-w-full rounded-lg border border-border bg-popover px-3.5 py-3 text-popover-foreground shadow-floating"
      data-theme-studio-notice
    >
      <div className="text-[13px] leading-snug font-semibold">
        {t('auto.app-shell.themeStudio.previewing', 'Previewing {{value0}}', { value0: name })}
      </div>
      <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
        {detail ??
          t(
            'auto.app-shell.themeStudio.previewHint',
            'An agent is editing this theme. Keep saves it as one of your themes.'
          )}
      </p>
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" onClick={onKeep}>
          {t('auto.app-shell.themeStudio.keep', 'Keep')}
        </Button>
        {/* Why secondary and ghost: one affirmative action, a quiet step back, and Discard as
            the back-out path (STYLEGUIDE: not destructive, no color). */}
        <Button size="sm" variant="secondary" onClick={onUndo} disabled={!canUndo}>
          {t('auto.app-shell.themeStudio.undo', 'Undo')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          {t('auto.app-shell.themeStudio.discard', 'Discard')}
        </Button>
      </div>
    </div>
  )
}
