import { useMemo } from 'react'
import { View, Text, Pressable } from 'react-native'
import { ChevronRight, Minus, Plus, type LucideIcon } from 'lucide-react-native'
import { MobileSwitch } from '../components/MobileSwitch'
import { PickerModal } from '../components/PickerModal'
import { voiceSettingsStyles as styles } from '../settings/voice-settings-styles'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { readAloudStyles } from './read-aloud-settings-styles'
import { useLanguageVoices } from './reading-preferences'
import { speakVoiceSample, useSpeechOptions } from './speech-options'
import {
  MAX_RATE,
  MIN_RATE,
  PHONE_SETTING,
  describeSpeed,
  describeVoice,
  stepRate,
  voiceChoices,
  voicePickerOptions
} from './voice-choice'

export type VoicePicker = 'voice'

type SpeechOptionsState = ReturnType<typeof useSpeechOptions>

function useVoiceChoices(state: SpeechOptionsState) {
  const { voices, options } = state
  return useMemo(() => (voices ? voiceChoices(voices, options.voice) : []), [voices, options.voice])
}

function ValueRow({
  label,
  value,
  onPress
}: {
  label: string
  value: string
  onPress: () => void
}) {
  useMobileColorScheme()
  return (
    <Pressable accessibilityRole="button" style={styles.row} onPress={onPress}>
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowSublabel}>{value}</Text>
      </View>
      <ChevronRight size={18} color={colors.textMuted} />
    </Pressable>
  )
}

function StepButton({
  label,
  Icon,
  disabled,
  onPress
}: {
  label: string
  Icon: LucideIcon
  disabled: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      style={[readAloudStyles.stepButton, disabled && styles.disabled]}
      onPress={onPress}
    >
      <Icon size={18} color={colors.textPrimary} />
    </Pressable>
  )
}

function SpeedRows({ state }: { state: SpeechOptionsState }) {
  useMobileColorScheme()
  const { options, phoneRate, setOptions } = state
  const current = options.rate ?? phoneRate
  const step = (direction: 1 | -1) =>
    setOptions({ ...options, rate: stepRate(options.rate, phoneRate, direction) })
  return (
    <>
      <View style={styles.row}>
        <View style={styles.rowContent}>
          <Text style={styles.rowLabel}>Speed</Text>
          <Text style={styles.rowSublabel}>{describeSpeed(options.rate, phoneRate)}</Text>
        </View>
        <StepButton
          label="Slower"
          Icon={Minus}
          disabled={current <= MIN_RATE}
          onPress={() => step(-1)}
        />
        <StepButton
          label="Faster"
          Icon={Plus}
          disabled={current >= MAX_RATE}
          onPress={() => step(1)}
        />
      </View>
      {options.rate !== null ? (
        <>
          <View style={styles.separator} />
          <Pressable
            accessibilityRole="button"
            style={styles.row}
            onPress={() => setOptions({ ...options, rate: null })}
          >
            <Text style={styles.rowLabel}>Use the phone&apos;s speed</Text>
          </Pressable>
        </>
      ) : null}
    </>
  )
}

function LanguageVoicesRow() {
  useMobileColorScheme()
  const { value, setValue } = useLanguageVoices()
  return (
    <View style={styles.row}>
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>Other languages in their own voice</Text>
        <Text style={styles.rowSublabel}>
          {value === 'on'
            ? "On — a whole sentence in another language uses that language's offline voice, when the phone has one and is sure of the language"
            : 'Off — everything is read by the voice above'}
        </Text>
      </View>
      <MobileSwitch
        accessibilityLabel="Other languages in their own voice"
        value={value === 'on'}
        onValueChange={(on) => setValue(on ? 'on' : 'off')}
      />
    </View>
  )
}

export function ReadAloudVoiceGroup({
  state,
  onOpenPicker
}: {
  state: SpeechOptionsState
  onOpenPicker: (picker: VoicePicker) => void
}) {
  useMobileColorScheme()
  const choices = useVoiceChoices(state)
  return (
    <>
      <Text style={[styles.groupHeading, readAloudStyles.groupGap]}>VOICE</Text>
      <Text style={readAloudStyles.groupDescription}>
        Applies to the Read button and auto-read. Every change reads a short sample.
      </Text>
      <View style={[styles.section, styles.sectionTopGap]}>
        {state.available ? (
          <>
            <SpeedRows state={state} />
            <View style={styles.separator} />
            <ValueRow
              label="Voice"
              value={describeVoice(state.options.voice, choices)}
              onPress={() => onOpenPicker('voice')}
            />
            <View style={styles.separator} />
            <LanguageVoicesRow />
            <View style={styles.separator} />
          </>
        ) : null}
        <Pressable accessibilityRole="button" style={styles.row} onPress={speakVoiceSample}>
          <Text style={styles.rowLabel}>Test voice</Text>
        </Pressable>
        {state.available ? (
          <>
            <View style={styles.separator} />
            <ValueRow
              label="Phone text-to-speech settings"
              value="More voices to download, another speech engine"
              onPress={state.openPhoneSettings}
            />
          </>
        ) : null}
      </View>
    </>
  )
}

// Why: rendered at the screen's root, outside the scroll view, so the drawer is not clipped.
export function ReadAloudVoicePickers({
  state,
  picker,
  onClose
}: {
  state: SpeechOptionsState
  picker: VoicePicker | null
  onClose: () => void
}) {
  const choices = useVoiceChoices(state)
  const { options, setOptions } = state
  return (
    <PickerModal
      visible={picker === 'voice'}
      title="Voice"
      subtitle={
        state.voices === undefined
          ? 'Loading the voices…'
          : state.voices === null
            ? 'The phone did not list its voices'
            : "Offline voices in the phone's reading language"
      }
      options={voicePickerOptions(choices)}
      selected={options.voice ?? PHONE_SETTING}
      onSelect={(value) =>
        setOptions({ ...options, voice: value === PHONE_SETTING ? null : value })
      }
      onClose={onClose}
    />
  )
}
