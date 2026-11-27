import type { PickerOption } from '../components/sheets/PickerModal'
import type { Translate } from '../i18n/mobile-i18n'
import type { DictationShortcutMode } from '../../../src/shared/speech/dictation/dictation-shortcut-mode'

/** The dictation modes the computer offers, each with what it does as its subtitle. */
export function dictationModes(t: Translate, offersAuto: boolean): PickerOption<string>[] {
  const toggle = {
    value: 'toggle',
    label: t('settings.voiceSettingsScreen.toggleMode', 'Toggle'),
    subtitle: t('settings.voiceSettingsScreen.toggleModeHint', 'Tap to start, tap again to stop')
  }
  const hold = {
    value: 'hold',
    label: t('settings.voiceSettingsScreen.holdMode', 'Hold'),
    subtitle: t('settings.voiceSettingsScreen.holdModeHint', 'Talk while you hold')
  }
  const auto = {
    value: 'auto',
    label: t('settings.voiceSettingsScreen.autoMode', 'Auto'),
    subtitle: t(
      'settings.voiceSettingsScreen.autoModeHint',
      'Tap to start and stop; hold the shortcut on the computer'
    )
  }
  return offersAuto ? [auto, hold, toggle] : [toggle, hold]
}

export function isDictationShortcutMode(value: string): value is DictationShortcutMode {
  return value === 'auto' || value === 'hold' || value === 'toggle'
}
