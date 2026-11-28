import { ActivityIndicator, View } from 'react-native'
import { Download, Trash2 } from 'lucide-react-native'
import { feedback } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { ListGroup, ListRow } from '../../components/list/ListGroup'
import { SwipeRowActions } from '../../components/list/SwipeRowActions'
import type { Translate } from '../../i18n/mobile-i18n'
import { intlLocaleFor } from '../../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import {
  cloudModelNeedsKey,
  dictationModelRowAction,
  isModelInFlight,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../mobile-dictation-setup'

type Props = {
  setup: MobileSpeechSetup
  // Disabled mirrors desktop: the model list greys out when dictation is off.
  disabled: boolean
  busyAction: { modelId: string; type: 'download' | 'select' | 'delete' } | null
  onUseModel: (model: MobileSpeechModel) => void
  onDownload: (model: MobileSpeechModel) => void
  onDelete: (model: MobileSpeechModel) => void
}

function formatSize(bytes: number | null | undefined, t: Translate, intlLocale: string): string {
  if (!bytes) {
    return ''
  }
  return t('components.voiceModelList.modelSize', '{{size}} MB', {
    size: Math.round(bytes / 1_000_000).toLocaleString(intlLocale)
  })
}

function modelMeta(model: MobileSpeechModel, t: Translate, intlLocale: string): string {
  if (model.provider === 'openai') {
    return 'OpenAI API'
  }
  const inFlight = isModelInFlight(model)
  if (inFlight && model.progress != null) {
    return t('components.voiceModelList.modelProgress', '{{size}} · {{progress}}%', {
      size: formatSize(model.sizeBytes, t, intlLocale),
      progress: Math.round(model.progress * 100).toLocaleString(intlLocale)
    })
  }
  if (model.status === 'extracting') {
    return t('components.voiceModelList.modelExtracting', '{{size}} · extracting…', {
      size: formatSize(model.sizeBytes, t, intlLocale)
    })
  }
  return formatSize(model.sizeBytes, t, intlLocale)
}

/** "Recommended · 142 MB", or what the row can't do yet ("Needs an OpenAI key"). */
function modelSubtitle(
  model: MobileSpeechModel,
  needsKey: boolean,
  t: Translate,
  intlLocale: string
): string {
  const parts = [
    model.recommended ? t('components.voiceModelList.recommended', 'Recommended') : '',
    needsKey ? cloudModelNeedsKey(t) : modelMeta(model, t, intlLocale)
  ]
  return parts.filter(Boolean).join(' · ')
}

// The speech models as one pick-one list, shared by setup and Voice settings: a ready model is picked
// with a tap, a missing one downloads with a tap, and a downloaded one deletes with a left swipe.
export function VoiceModelList({
  setup,
  disabled,
  busyAction,
  onUseModel,
  onDownload,
  onDelete
}: Props): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const anyBusy = busyAction !== null
  return (
    <View
      style={disabled ? styles.disabled : undefined}
      pointerEvents={disabled ? 'none' : 'auto'}
      accessibilityRole="radiogroup"
    >
      <ListGroup>
        {setup.models.map((model) => {
          const action = dictationModelRowAction(model, setup.selectedModelId)
          const rowBusy = busyAction?.modelId === model.id
          const ready = action === 'in-use' || action === 'use'
          const label = model.label ?? model.id
          const row = (guardPress: (onPress: () => void) => () => void) => (
            <ListRow
              title={label}
              subtitle={
                modelSubtitle(model, action === 'needs-api-key', t, intlLocale) || undefined
              }
              selected={ready ? action === 'in-use' : undefined}
              busy={anyBusy}
              accessory={
                rowBusy || action === 'downloading' ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : action === 'download' ? (
                  <Download size={18} color={colors.textSecondary} strokeWidth={2.2} />
                ) : undefined
              }
              accessibilityLabel={
                action === 'download'
                  ? t('components.voiceModelList.downloadModel', 'Download {{label}}', { label })
                  : undefined
              }
              onPress={
                action === 'use'
                  ? guardPress(() => onUseModel(model))
                  : action === 'download'
                    ? guardPress(() => onDownload(model))
                    : undefined
              }
            />
          )
          // A cloud model has nothing on the computer to delete.
          return ready && model.provider !== 'openai' ? (
            <SwipeRowActions
              key={model.id}
              enabled={!anyBusy}
              trailing={{
                label: t('components.voiceModelList.delete', 'Delete'),
                accessibilityLabel: t('components.voiceModelList.deleteModel', 'Delete {{label}}', {
                  label
                }),
                icon: Trash2,
                background: colors.statusRed,
                foreground: colors.onStatusRed,
                onPress: () => onDelete(model)
              }}
            >
              {row}
            </SwipeRowActions>
          ) : (
            <View key={model.id}>{row((onPress) => onPress)}</View>
          )
        })}
      </ListGroup>
    </View>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  disabled: { opacity: feedback.disabledOpacity }
}))
