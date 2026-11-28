import type { Translate } from '../i18n/mobile-i18n'
import type {
  MobileDictationEngineShown,
  MobileDictationKeptFailure
} from '../hooks/mobile-dictation-session-state'
import { MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE } from '../hooks/mobile-dictation-pending-audio-budget'
import { phoneDictationFailedMessage } from '../hooks/mobile-dictation-device-engine'
import { dictationFailureMessage, dictationSessionLostMessage } from './mobile-dictation-setup'

// Active: starting or recording, so the mic is a Stop.
export type MobileDictationMicState = { starting: boolean; active: boolean; processing: boolean }

// One set of dictation labels for the chat composer, the terminal and the pill.
export const dictationControlsCopy = {
  start: (t: Translate) => t('dictation.controls.start', 'Dictate'),
  starting: (t: Translate) => t('dictation.controls.starting', 'Starting dictation'),
  stop: (t: Translate) => t('dictation.controls.stop', 'Stop and insert'),
  finishing: (t: Translate) => t('dictation.controls.finishing', 'Finishing dictation'),
  cancel: (t: Translate) => t('dictation.controls.cancel', 'Cancel dictation'),
  discard: (t: Translate) => t('dictation.controls.discard', 'Discard recording'),
  retry: (t: Translate) => t('dictation.controls.retry', 'Retry dictation'),
  retryShort: (t: Translate) => t('dictation.controls.retryShort', 'Retry'),
  recordingKept: (t: Translate) => t('dictation.failure.recordingKept', 'Recording kept'),
  mic: ({ starting, active, processing }: MobileDictationMicState, t: Translate) =>
    starting
      ? dictationControlsCopy.starting(t)
      : active
        ? dictationControlsCopy.stop(t)
        : processing
          ? dictationControlsCopy.finishing(t)
          : dictationControlsCopy.start(t),
  finishingOn: (computer: string | null, t: Translate) =>
    computer
      ? t('dictation.status.finishingOn', 'Finishing on {{computer}}', { computer })
      : t('dictation.status.finishingOnComputer', 'Finishing on the computer'),
  movedTo: (computer: string | null, t: Translate) =>
    computer
      ? t('dictation.status.movedTo', 'Moved to {{computer}}', { computer })
      : t('dictation.status.movedToComputer', 'Moved to the computer')
}

export function dictationSpokenDuration(elapsedSeconds: number, t: Translate): string {
  const minutes = Math.floor(elapsedSeconds / 60)
  const count = elapsedSeconds % 60
  const seconds =
    count === 1
      ? t('dictation.controls.durationSeconds_one', '{{count}} second', { count })
      : t('dictation.controls.durationSeconds_other', '{{count}} seconds', { count })
  if (minutes === 0) {
    return seconds
  }
  const minuteText =
    minutes === 1
      ? t('dictation.controls.durationMinutes_one', '{{count}} minute', { count: minutes })
      : t('dictation.controls.durationMinutes_other', '{{count}} minutes', {
          count: minutes
        })
  return t('dictation.controls.durationMinutesSeconds', '{{minutes}} {{seconds}}', {
    minutes: minuteText,
    seconds
  })
}

// What a screen reader hears on the meter, which shows only dots, a timer and an icon.
export function dictationMeterLabel(
  elapsedSeconds: number,
  engine: MobileDictationEngineShown['kind'] | null,
  computer: string | null,
  t: Translate
): string {
  const duration = dictationSpokenDuration(elapsedSeconds, t)
  if (engine === 'phone') {
    return t('dictation.controls.meterOnPhone', 'Recording, {{duration}}, on this phone', {
      duration
    })
  }
  if (engine === 'computer') {
    return computer
      ? t('dictation.controls.meterOn', 'Recording, {{duration}}, on {{computer}}', {
          duration,
          computer
        })
      : t('dictation.controls.meterOnComputer', 'Recording, {{duration}}, on the computer', {
          duration
        })
  }
  return t('dictation.controls.meter', 'Recording, {{duration}}', { duration })
}

// The few words a kept failure shows in the composer row; the full message is too long for it.
export function dictationFailureReason(failure: MobileDictationKeptFailure, t: Translate): string {
  return (
    dictationKeptFailureCause(failure, t) ?? t('dictation.failure.stopped', 'Dictation stopped')
  )
}

// Why a kept failure stopped, when it is known; null for the generic stop.
export function dictationKeptFailureCause(
  { message, offline }: MobileDictationKeptFailure,
  t: Translate
): string | null {
  if (offline || dictationFailureMessage(message, t) === dictationSessionLostMessage(t)) {
    return t('dictation.failure.connectionLost', 'Connection lost')
  }
  if (message === MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE) {
    return t('dictation.failure.connectionSlow', 'Connection too slow')
  }
  if (message === phoneDictationFailedMessage(t)) {
    return t('dictation.failure.phoneStopped', 'Stopped on this phone')
  }
  return null
}
