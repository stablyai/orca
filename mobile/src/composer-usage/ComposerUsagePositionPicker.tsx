import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ComposerUsageChoiceRow } from './ComposerUsageChoiceRow'
import {
  setComposerUsagePosition,
  useComposerUsagePosition
} from './composer-usage-position-preference'

/** Picks whether the chat composer's meter sits in its controls row or on a line above the text. */
export function ComposerUsagePositionPicker({ inSettings = false }: { inSettings?: boolean }) {
  const t = useMobileTranslation()
  return (
    <ComposerUsageChoiceRow
      label={t('composerUsage.position.label', 'Meter position')}
      segments={[
        {
          value: 'row',
          label: t('composerUsage.position.row', 'Controls'),
          accessibilityLabel: t(
            'composerUsage.position.rowHint',
            'Show the meter in the controls row'
          )
        },
        {
          value: 'above',
          label: t('composerUsage.position.above', 'Above text'),
          accessibilityLabel: t(
            'composerUsage.position.aboveHint',
            'Show the meter on its own line above the text'
          )
        }
      ]}
      selected={useComposerUsagePosition()}
      onSelect={setComposerUsagePosition}
      inSettings={inSettings}
      testIDPrefix="composer-usage-position-"
    />
  )
}
