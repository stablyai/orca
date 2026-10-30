import type { PickerOption } from '../components/PickerModal'
import type { Translate } from '../i18n/mobile-i18n'
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

export function describeSpeed(t: Translate, rate: number | null, phoneRate: number): string {
  if (rate === null) {
    return t('settings.readAloudVoiceSettings.phoneSpeed', 'Phone setting ({{rate}})', {
      rate: rateLabel(phoneRate)
    })
  }
  return rate === 1
    ? t('settings.readAloudVoiceSettings.normalSpeed', 'Normal (1×)')
    : rateLabel(rate)
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
export function voiceChoices(
  t: Translate,
  list: NativeVoiceList,
  chosen: string | null
): VoiceChoice[] {
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
    label: t('settings.readAloudVoiceSettings.voiceNumber', 'Voice {{number}}', {
      number: variants.indexOf(variantOf(voice.name)) + 1
    }),
    detail: [
      voice.needsInternet
        ? t('settings.readAloudVoiceSettings.needsInternet', 'Needs internet')
        : null,
      voice.name === list.defaultVoice
        ? t('settings.readAloudVoiceSettings.phoneDefault', 'Phone default')
        : null
    ]
      .filter((part) => part !== null)
      .join(' · ')
  }))
}

export function voicePickerOptions(t: Translate, choices: VoiceChoice[]): PickerOption[] {
  return [
    {
      value: PHONE_SETTING,
      label: t('settings.readAloudVoiceSettings.phoneVoice', 'Phone setting'),
      subtitle: t(
        'settings.readAloudVoiceSettings.phoneVoiceDescription',
        "The voice in the phone's text-to-speech settings"
      )
    },
    ...choices.map((choice) => ({
      value: choice.name,
      label: choice.label,
      subtitle: choice.detail || undefined
    }))
  ]
}

export function describeVoice(t: Translate, chosen: string | null, choices: VoiceChoice[]): string {
  if (chosen === null) {
    return t('settings.readAloudVoiceSettings.phoneVoice', 'Phone setting')
  }
  const choice = choices.find((c) => c.name === chosen)
  if (!choice) {
    return chosen
  }
  return choice.detail ? `${choice.label} · ${choice.detail}` : choice.label
}
