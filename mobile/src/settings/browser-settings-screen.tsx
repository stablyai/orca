import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { Globe } from 'lucide-react-native'
import { ListRow } from '../components/list/ListGroup'
import { PickerModal, type PickerOption } from '../components/sheets/PickerModal'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  DEFAULT_LINK_OPEN_MODE,
  loadLinkOpenMode,
  saveLinkOpenMode,
  type MobileLinkOpenMode
} from '../storage/preferences'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsNote, SettingsScreen, SettingsSection } from './settings-screen-frame'

function linkModeOptions(t: Translate): PickerOption<MobileLinkOpenMode>[] {
  return [
    {
      value: 'ask',
      label: t('settings.browserSettingsScreen.askEachTime', 'Ask each time'),
      subtitle: t(
        'settings.browserSettingsScreen.askEachTimeDescription',
        'Choose Orca browser, phone browser, or copy the link each time.'
      )
    },
    {
      value: 'orca-browser',
      label: t('settings.browserSettingsScreen.desktopBrowser', 'Orca browser on desktop'),
      subtitle: t(
        'settings.browserSettingsScreen.desktopBrowserDescription',
        'Open in the streamed browser from your paired desktop.'
      )
    },
    {
      value: 'phone-browser',
      label: t('settings.browserSettingsScreen.phoneBrowser', 'Phone browser'),
      subtitle: t(
        'settings.browserSettingsScreen.phoneBrowserDescription',
        'Open in Safari, Chrome, or another browser on this phone.'
      )
    }
  ]
}

function linkModeLabel(
  mode: MobileLinkOpenMode,
  options: PickerOption<MobileLinkOpenMode>[]
): string {
  return options.find((option) => option.value === mode)?.label ?? options[0]!.label
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
  const [pickerOpen, setPickerOpen] = useState(false)
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
      overlays={
        <PickerModal<MobileLinkOpenMode>
          visible={pickerOpen}
          title={t('settings.browserSettingsScreen.openLinks', 'Open links')}
          options={options}
          selected={linkMode}
          onSelect={selectLinkMode}
          onClose={() => setPickerOpen(false)}
        />
      }
    >
      <SettingsSection
        first
        title={t('settings.browserSettingsScreen.linksHeading', 'Links')}
        footer={
          <>
            <SettingsNote>
              {t(
                'settings.browserSettingsScreen.terminalAndChatLinksDescription',
                'Choose where web links tapped in terminal output and chat open.'
              )}
            </SettingsNote>
            {errorNote}
          </>
        }
      >
        <ListRow
          key="linkMode"
          title={t('settings.browserSettingsScreen.openLinks', 'Open links')}
          subtitle={linkModeLabel(linkMode, options)}
          leading={<Globe size={18} color={colors.textSecondary} />}
          navigates
          accessibilityLabel={t('settings.browserSettingsScreen.openLinks', 'Open links')}
          onPress={() => setPickerOpen(true)}
        />
      </SettingsSection>
    </SettingsScreen>
  )
}
