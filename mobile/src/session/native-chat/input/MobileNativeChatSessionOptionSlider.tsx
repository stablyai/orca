import { useState } from 'react'
import { Text, View } from 'react-native'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  sessionOptionDispatchUnconfirmed,
  sessionOptionValueMarker,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceShortLabel,
  nativeChatSessionOptionLabel
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import { SessionOptionCaption } from './MobileNativeChatSessionOptionRows'
import { MobileSessionOptionSliderTrack } from './MobileSessionOptionSliderTrack'

export type MobileSessionOptionSliderTrackProps = {
  count: number
  value: number | null
  label: string
  valueText: string
  disabled: boolean
  onPreview: (index: number | null) => void
  onCommit: (index: number) => void
}

export function showsSessionOptionAsSlider(descriptor: SessionOptionDescriptor): boolean {
  return (
    descriptor.category === 'thought_level' &&
    descriptor.kind.type === 'select' &&
    !descriptor.action &&
    descriptor.kind.choices.length > 1
  )
}

export function SessionOptionSlider(props: {
  descriptor: SessionOptionDescriptor
  disabled: boolean
  onSetOption: (value: SessionOptionValue) => void
}): React.JSX.Element | null {
  const { descriptor, disabled, onSetOption } = props
  if (descriptor.kind.type !== 'select') {
    return null
  }
  return (
    <Slider
      key={JSON.stringify([descriptor.kind.currentValue, descriptor.kind.choices])}
      descriptor={{ ...descriptor, kind: descriptor.kind }}
      disabled={disabled || !descriptor.settable}
      onSetOption={onSetOption}
    />
  )
}

function Slider({
  descriptor,
  disabled,
  onSetOption
}: {
  descriptor: SessionOptionDescriptor & { kind: { type: 'select' } }
  disabled: boolean
  onSetOption: (value: SessionOptionValue) => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [preview, setPreview] = useState<number | null>(null)
  const { choices, currentValue } = descriptor.kind
  const current =
    descriptor.valueSource === 'unknown'
      ? -1
      : choices.findIndex((choice) => choice.value === currentValue)
  const choice = choices[preview ?? current]
  const label = nativeChatSessionOptionLabel(descriptor, say)
  const marker = sessionOptionValueMarker(descriptor)
  const valueText = choice
    ? nativeChatSessionChoiceShortLabel(choice, say, descriptor.id)
    : t('chat.sessionOptionRows.notReportedMarker', 'Not reported')
  return (
    <View style={styles.option}>
      <View style={styles.heading}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>
          {preview === null && marker === 'default'
            ? `${valueText} (${t('chat.sessionOptionRows.defaultMarker', 'Default')})`
            : valueText}
        </Text>
      </View>
      <MobileSessionOptionSliderTrack
        count={choices.length}
        value={current < 0 ? null : current}
        label={label}
        valueText={valueText}
        disabled={disabled}
        onPreview={setPreview}
        onCommit={(index) => {
          setPreview(null)
          const picked = choices[index]
          if (!disabled && picked) {
            onSetOption(picked.value)
          }
        }}
      />
      {sessionOptionDispatchUnconfirmed(descriptor) ? (
        <SessionOptionCaption>
          {t('chat.sessionOptionSegments.dispatchUnconfirmed', 'Sent to the agent — not confirmed')}
        </SessionOptionCaption>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  option: { paddingHorizontal: spacing.lg },
  heading: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  label: { color: colors.textSecondary, fontSize: typography.metaSize },
  value: { color: colors.textPrimary, fontSize: typography.metaSize, flexShrink: 1 }
}))
