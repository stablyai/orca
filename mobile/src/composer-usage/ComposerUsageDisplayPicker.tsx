import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ComposerUsageChoiceRow } from './ComposerUsageChoiceRow'
import {
  setComposerUsageDisplay,
  useComposerUsageDisplay
} from './composer-usage-display-preference'

/** Picks whether the composer meter shows used or remaining. One choice for every composer. */
export function ComposerUsageDisplayPicker({ inSettings = false }: { inSettings?: boolean }) {
  const t = useMobileTranslation()
  return (
    <ComposerUsageChoiceRow
      label={t('composerUsage.display.label', 'Meter shows')}
      segments={[
        {
          value: 'used',
          label: t('composerUsage.display.used', 'Used'),
          accessibilityLabel: t(
            'composerUsage.display.usedHint',
            'Show how much of the window is used'
          )
        },
        {
          value: 'remaining',
          label: t('composerUsage.display.remaining', 'Remaining'),
          accessibilityLabel: t(
            'composerUsage.display.remainingHint',
            'Show how much of the window is left'
          )
        }
      ]}
      selected={useComposerUsageDisplay()}
      onSelect={setComposerUsageDisplay}
      inSettings={inSettings}
      testIDPrefix="composer-usage-display-"
    />
  )
}
