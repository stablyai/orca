import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'
import {
  addExpoTwoWayAudioEventListener,
  hasNativeSpeech,
  speechAvailability,
  speechDownload,
  type SpeechAvailabilityStatus
} from '@orca/expo-two-way-audio'
import { ListRow } from '../components/list/ListGroup'
import type { Translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { DictationEnginePreference } from '../mobile-web-shell/bridge/bridge-speech-verbs'
import { isSpeechBusyError } from '../platform/speech/native-speech'
import { onDeviceSpeechLocale } from '../platform/speech/on-device-speech-locale'
import {
  DEFAULT_DICTATION_ENGINE_PREFERENCE,
  loadDictationEnginePreference,
  saveDictationEnginePreference
} from '../storage/dictation-engine-preference'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsSection } from './settings-screen-frame'

type PhoneSpeech =
  | { status: SpeechAvailabilityStatus | 'checking' }
  | { status: 'downloading'; progress: number }

function phoneStatusText(phone: PhoneSpeech | null, t: Translate): string | undefined {
  switch (phone?.status) {
    case undefined:
      return undefined
    case 'checking':
      return t('settings.voiceTranscribeOn.phoneChecking', 'Checking…')
    case 'ready':
      return t('settings.voiceTranscribeOn.phoneReady', 'Ready on this phone')
    case 'needs-download':
      return t('settings.voiceTranscribeOn.phoneNeedsDownload', 'Needs a language download')
    case 'downloading':
      return t('settings.voiceTranscribeOn.phoneDownloading', 'Downloading… {{progress}}%', {
        progress: Math.round(phone.progress * 100).toLocaleString(getUiIntlLocale())
      })
    case 'unsupported':
      // Covers an unsupported language and a phone or OS that can't run the recognizer.
      return t('settings.voiceTranscribeOn.phoneUnsupported', 'Not available on this phone')
  }
}

// Assets are only ever downloaded on this tap, so say the size first when we know it. The OS reports none up front;
// these were measured for en-US only (iOS 456 MB, Android's system pack 63 MB), so other languages show no size.
const PHONE_SPEECH_EN_DOWNLOAD_MB: Partial<Record<typeof Platform.OS, number>> = {
  ios: 450,
  android: 65
}

function downloadSizeText(t: Translate, locale: string): string | undefined {
  const size = /^en(-|$)/i.test(locale) ? PHONE_SPEECH_EN_DOWNLOAD_MB[Platform.OS] : undefined
  return size === undefined
    ? undefined
    : t('settings.voiceTranscribeOn.downloadSize', 'About {{size}} MB', {
        size: size.toLocaleString(getUiIntlLocale())
      })
}

const PHONE_SPEECH_RECHECK_MS = 3_000

// A shell built before on-device speech has nothing to choose between.
export function voiceTranscribeOnShown(): boolean {
  return hasNativeSpeech()
}

// Where dictation is transcribed: on this phone, on the paired computer, or the phone when it can. Phone-only, so it shows without a computer.
export function VoiceTranscribeOnSection() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [preference, setPreference] = useState<DictationEnginePreference>(
    DEFAULT_DICTATION_ENGINE_PREFERENCE
  )
  const [phone, setPhone] = useState<PhoneSpeech | null>(null)
  // Progress events and the download's promise arrive apart; a late event must not reopen a finished download.
  const downloadingRef = useRef(false)
  const supported = voiceTranscribeOnShown()

  // A busy speech service shows as checking and is asked again while this screen is open; it is never read as unsupported.
  const readPhone = useCallback(async () => {
    try {
      const available = await speechAvailability(onDeviceSpeechLocale())
      setPhone({ status: available.status })
    } catch (error) {
      setPhone({ status: isSpeechBusyError(error) ? 'checking' : 'unsupported' })
    }
  }, [])

  // Keyed on the state object: each busy answer is a new one, so it schedules the next check.
  useEffect(() => {
    if (phone?.status !== 'checking') {
      return
    }
    const recheck = setTimeout(() => void readPhone(), PHONE_SPEECH_RECHECK_MS)
    return () => clearTimeout(recheck)
  }, [phone, readPhone])

  useEffect(() => {
    if (!supported) {
      return
    }
    void loadDictationEnginePreference().then(setPreference)
    void readPhone()
    const progress = addExpoTwoWayAudioEventListener('onSpeechDownloadProgress', (event) => {
      if (!downloadingRef.current) {
        return
      }
      setPhone({ status: 'downloading', progress: Math.min(1, Math.max(0, event.fraction)) })
    })
    return () => progress.remove()
  }, [readPhone, supported])

  if (!supported) {
    return null
  }

  const choose = (next: DictationEnginePreference) => {
    setPreference(next)
    void saveDictationEnginePreference(next).catch(() => {})
  }

  const downloadTitle = t('settings.voiceTranscribeOn.download', 'Download for this phone')
  const downloadSize = downloadSizeText(t, onDeviceSpeechLocale())

  const download = () => {
    if (downloadingRef.current) {
      return
    }
    downloadingRef.current = true
    setPhone({ status: 'downloading', progress: 0 })
    void speechDownload(onDeviceSpeechLocale())
      .catch(() => false)
      .then(() => {
        downloadingRef.current = false
        return readPhone()
      })
  }

  return (
    <SettingsSection
      first
      radioGroup
      title={t('settings.voiceTranscribeOn.heading', 'TRANSCRIBE ON')}
      footer={t(
        'settings.voiceTranscribeOn.description',
        'Speech heard on this phone stays on it. Automatic uses your computer when this phone can’t transcribe.'
      )}
    >
      <ListRow
        key="automatic"
        title={t('settings.voiceTranscribeOn.automatic', 'Automatic')}
        selected={preference === 'automatic'}
        onPress={() => choose('automatic')}
      />
      <ListRow
        key="phone"
        title={t('settings.voiceTranscribeOn.phone', 'This phone')}
        subtitle={phoneStatusText(phone, t)}
        selected={preference === 'phone'}
        disabled={phone?.status === 'unsupported'}
        onPress={() => choose('phone')}
      />
      <ListRow
        key="computer"
        title={t('settings.voiceTranscribeOn.computer', 'Computer')}
        selected={preference === 'computer'}
        onPress={() => choose('computer')}
      />
      {phone?.status === 'needs-download' || phone?.status === 'downloading' ? (
        <ListRow
          key="download"
          title={downloadTitle}
          subtitle={downloadSize}
          // The row's default label is its title alone; screen readers need the size before the tap too.
          accessibilityLabel={downloadSize ? `${downloadTitle}, ${downloadSize}` : downloadTitle}
          busy={phone.status === 'downloading'}
          onPress={download}
        />
      ) : null}
    </SettingsSection>
  )
}
