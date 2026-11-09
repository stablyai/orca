import { translate } from '../i18n/mobile-i18n'
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
  start: () => translate('dictation.controls.start', 'Dictate'),
  starting: () => translate('dictation.controls.starting', 'Starting dictation'),
  stop: () => translate('dictation.controls.stop', 'Stop and insert'),
  finishing: () => translate('dictation.controls.finishing', 'Finishing dictation'),
  cancel: () => translate('dictation.controls.cancel', 'Cancel dictation'),
  discard: () => translate('dictation.controls.discard', 'Discard recording'),
  retry: () => translate('dictation.controls.retry', 'Retry dictation'),
  retryShort: () => translate('dictation.controls.retryShort', 'Retry'),
  recordingKept: () => translate('dictation.failure.recordingKept', 'Recording kept'),
  mic: ({ starting, active, processing }: MobileDictationMicState) =>
    starting
      ? dictationControlsCopy.starting()
      : active
        ? dictationControlsCopy.stop()
        : processing
          ? dictationControlsCopy.finishing()
          : dictationControlsCopy.start(),
  finishingOn: (computer: string | null) =>
    computer
      ? translate('dictation.status.finishingOn', 'Finishing on {{computer}}', { computer })
      : translate('dictation.status.finishingOnComputer', 'Finishing on the computer'),
  movedTo: (computer: string | null) =>
    computer
      ? translate('dictation.status.movedTo', 'Moved to {{computer}}', { computer })
      : translate('dictation.status.movedToComputer', 'Moved to the computer')
}

export function dictationSpokenDuration(elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60)
  const count = elapsedSeconds % 60
  const seconds =
    count === 1
      ? translate('dictation.controls.durationSeconds_one', '{{count}} second', { count })
      : translate('dictation.controls.durationSeconds_other', '{{count}} seconds', { count })
  if (minutes === 0) {
    return seconds
  }
  const minuteText =
    minutes === 1
      ? translate('dictation.controls.durationMinutes_one', '{{count}} minute', { count: minutes })
      : translate('dictation.controls.durationMinutes_other', '{{count}} minutes', {
          count: minutes
        })
  return translate('dictation.controls.durationMinutesSeconds', '{{minutes}} {{seconds}}', {
    minutes: minuteText,
    seconds
  })
}

// What a screen reader hears on the meter, which shows only dots, a timer and an icon.
export function dictationMeterLabel(
  elapsedSeconds: number,
  engine: MobileDictationEngineShown['kind'] | null,
  computer: string | null
): string {
  const duration = dictationSpokenDuration(elapsedSeconds)
  if (engine === 'phone') {
    return translate('dictation.controls.meterOnPhone', 'Recording, {{duration}}, on this phone', {
      duration
    })
  }
  if (engine === 'computer') {
    return computer
      ? translate('dictation.controls.meterOn', 'Recording, {{duration}}, on {{computer}}', {
          duration,
          computer
        })
      : translate(
          'dictation.controls.meterOnComputer',
          'Recording, {{duration}}, on the computer',
          {
            duration
          }
        )
  }
  return translate('dictation.controls.meter', 'Recording, {{duration}}', { duration })
}

// The few words a kept failure shows in the composer row; the full message is too long for it.
export function dictationFailureReason({ message, offline }: MobileDictationKeptFailure): string {
  if (offline || dictationFailureMessage(message) === dictationSessionLostMessage()) {
    return translate('dictation.failure.connectionLost', 'Connection lost')
  }
  if (message === MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE) {
    return translate('dictation.failure.connectionSlow', 'Connection too slow')
  }
  if (message === phoneDictationFailedMessage()) {
    return translate('dictation.failure.phoneStopped', 'Stopped on this phone')
  }
  return translate('dictation.failure.stopped', 'Dictation stopped')
}
