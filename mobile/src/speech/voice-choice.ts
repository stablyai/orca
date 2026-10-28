import type { PickerOption } from '../components/PickerModal'
import type { NativeVoiceList } from './voice-native-module'

/** Picker value for "whatever the phone's text-to-speech settings say". */
export const PHONE_SETTING = 'phone-setting'

export const MIN_RATE = 0.75
export const MAX_RATE = 2
const RATE_STEPS_PER_UNIT = 20

function snapRate(rate: number): number {
  const snapped = Math.round(rate * RATE_STEPS_PER_UNIT) / RATE_STEPS_PER_UNIT
  return Math.min(MAX_RATE, Math.max(MIN_RATE, snapped))
}

export function stepRate(rate: number | null, phoneRate: number, direction: 1 | -1): number {
  return snapRate(snapRate(rate ?? phoneRate) + direction / RATE_STEPS_PER_UNIT)
}

function rateLabel(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}

export function describeSpeed(rate: number | null, phoneRate: number): string {
  if (rate === null) {
    return `Phone setting (${rateLabel(phoneRate)})`
  }
  return rate === 1 ? 'Normal (1×)' : rateLabel(rate)
}

function primaryLanguage(tag: string): string {
  return (tag.split(/[-_]/)[0] ?? '').toLowerCase()
}

// Why: Google's voices come in pairs that differ only by this suffix — one on the phone, one
// online — so a pair shares a number and the user hears it as one voice.
function variantOf(name: string): string {
  return name.replace(/-(local|network)$/i, '')
}

export type VoiceChoice = { name: string; label: string; detail: string }

/**
 * Numbered, as engine names (`pl-pl-x-oda-local`) mean nothing to a listener. Online voices are
 * left out unless chosen: they go quiet where the signal drops.
 */
export function voiceChoices(list: NativeVoiceList, chosen: string | null): VoiceChoice[] {
  const language = primaryLanguage(list.language)
  const voices = list.voices
    .filter(
      (voice) =>
        voice.name === chosen ||
        (voice.installed && !voice.needsInternet && primaryLanguage(voice.language) === language)
    )
    .sort((a, b) => a.name.localeCompare(b.name))
  const variants = [...new Set(voices.map((voice) => variantOf(voice.name)))]
  return voices.map((voice) => ({
    name: voice.name,
    label: `Voice ${variants.indexOf(variantOf(voice.name)) + 1}`,
    detail: [
      voice.needsInternet ? 'Needs internet' : null,
      voice.name === list.defaultVoice ? 'Phone default' : null
    ]
      .filter((part) => part !== null)
      .join(' · ')
  }))
}

export function voicePickerOptions(choices: VoiceChoice[]): PickerOption[] {
  return [
    {
      value: PHONE_SETTING,
      label: 'Phone setting',
      subtitle: "The voice in the phone's text-to-speech settings"
    },
    ...choices.map((choice) => ({
      value: choice.name,
      label: choice.label,
      subtitle: choice.detail || undefined
    }))
  ]
}

export function describeVoice(chosen: string | null, choices: VoiceChoice[]): string {
  if (chosen === null) {
    return 'Phone setting'
  }
  const choice = choices.find((c) => c.name === chosen)
  if (!choice) {
    return chosen
  }
  return choice.detail ? `${choice.label} · ${choice.detail}` : choice.label
}
