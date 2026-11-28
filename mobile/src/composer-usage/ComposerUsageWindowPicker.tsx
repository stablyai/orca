import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { composerUsageWindowToggleChoices, type UsageWindowEntry } from './agent-usage-provider'
import { ComposerUsageChoiceRow } from './ComposerUsageChoiceRow'
import { setComposerUsageWindow, useComposerUsageWindow } from './composer-usage-window-preference'

/** Picks the window the composer meter shows; lives in Settings and in the usage sheet. */
export function ComposerUsageWindowPicker({
  inSettings = false,
  windows
}: {
  inSettings?: boolean
  /** The open provider's windows. Settings has no provider, so it keeps both choices. */
  windows?: readonly UsageWindowEntry[]
}) {
  const t = useMobileTranslation()
  const choice = useComposerUsageWindow()
  const choices = windows
    ? composerUsageWindowToggleChoices(windows)
    : (['session', 'weekly'] as const)
  if (choices.length < 2) {
    return null
  }
  const segments = choices.map((value) => ({
    value,
    label:
      value === 'session'
        ? t('composerUsage.picker.session', '5-hour')
        : t('composerUsage.picker.weekly', 'Weekly')
  }))
  return (
    <ComposerUsageChoiceRow
      label={t('composerUsage.picker.label', 'Show in composer')}
      segments={segments}
      selected={choice}
      onSelect={setComposerUsageWindow}
      inSettings={inSettings}
      testIDPrefix="composer-usage-window-"
    />
  )
}
