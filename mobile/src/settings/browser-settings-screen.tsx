import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { ListRow } from '../components/list/ListGroup'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  DEFAULT_LINK_OPEN_MODE,
  loadLinkOpenMode,
  saveLinkOpenMode,
  type MobileLinkOpenMode
} from '../storage/preferences'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsNote, SettingsScreen, SettingsSection } from './settings-screen-frame'

function linkModeOptions(
  t: Translate
): { value: MobileLinkOpenMode; label: string; subtitle: string }[] {
  return [
    {
      value: 'ask',
      label: t('settings.browserSettingsScreen.askEachTime', 'Ask each time'),
      subtitle: t('settings.browserSettingsScreen.askHint', 'Pick a browser or copy the link')
    },
    {
      value: 'orca-browser',
      label: t('settings.browserSettingsScreen.desktopBrowser', 'Orca browser on desktop'),
      subtitle: t('settings.browserSettingsScreen.desktopHint', 'Streamed from your computer')
    },
    {
      value: 'phone-browser',
      label: t('settings.browserSettingsScreen.phoneBrowser', 'Phone browser'),
      subtitle: t('settings.browserSettingsScreen.phoneHint', 'Safari, Chrome or another app')
    }
  ]
}

export default function BrowserSettingsScreen({
  onBack
}: {
  onBack?: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const router = useRouter()
  const [linkMode, setLinkMode] = useState<MobileLinkOpenMode>(DEFAULT_LINK_OPEN_MODE)
  const [error, setError] = useState<'load' | 'save' | null>(null)
  const options = linkModeOptions(t)
  const selectionRevision = useRef(0)
  const failedSelectionRevision = useRef<number | null>(null)
  const savedMode = useRef<MobileLinkOpenMode>(DEFAULT_LINK_OPEN_MODE)
  const hasSaved = useRef(false)

  useEffect(() => {
    let active = true
    void loadLinkOpenMode().then(
      (mode) => {
        if (!hasSaved.current) {
          savedMode.current = mode
        }
        if (
          active &&
          (selectionRevision.current === 0 ||
            failedSelectionRevision.current === selectionRevision.current)
        ) {
          setLinkMode(savedMode.current)
        }
      },
      () => {
        if (active) {
          setError('load')
        }
      }
    )
    return () => {
      active = false
    }
  }, [])

  const selectLinkMode = useCallback((mode: MobileLinkOpenMode) => {
    setError(null)
    const revision = ++selectionRevision.current
    setLinkMode(mode)
    void saveLinkOpenMode(mode).then(
      () => {
        savedMode.current = mode
        hasSaved.current = true
      },
      () => {
        if (revision === selectionRevision.current) {
          failedSelectionRevision.current = revision
          setLinkMode(savedMode.current)
          setError('save')
        }
      }
    )
  }, [])

  const errorNote = error ? (
    <SettingsNote error>
      {error === 'load'
        ? t(
            'settings.browserSettingsScreen.loadFailed',
            'Could not load browser preferences. Try again.'
          )
        : t(
            'settings.browserSettingsScreen.saveFailed',
            'Could not save browser preferences. Try again.'
          )}
    </SettingsNote>
  ) : null

  return (
    <SettingsScreen
      title={t('settings.browserSettingsScreen.title', 'Browser')}
      onBack={onBack ?? (() => router.back())}
    >
      <SettingsSection
        first
        radioGroup
        title={t('settings.browserSettingsScreen.openLinks', 'Open links')}
        footer={errorNote}
      >
        {options.map((option) => (
          <ListRow
            key={option.value}
            title={option.label}
            subtitle={option.subtitle}
            selected={linkMode === option.value}
            onPress={() => selectLinkMode(option.value)}
          />
        ))}
      </SettingsSection>
    </SettingsScreen>
  )
}
