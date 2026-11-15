import { useState } from 'react'
import { useRouter } from 'expo-router'
import { Globe, Network } from 'lucide-react-native'
import { ListRow } from '../components/list/ListGroup'
import { PickerModal, type PickerOption } from '../components/sheets/PickerModal'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  DEFAULT_BROWSER_DRAWING,
  DEFAULT_LINK_OPEN_MODE,
  loadBrowserDrawing,
  loadLinkOpenMode,
  saveBrowserDrawing,
  saveLinkOpenMode,
  type MobileBrowserDrawing,
  type MobileLinkOpenMode
} from '../storage/preferences'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsNote, SettingsScreen, SettingsSection } from './settings-screen-frame'
import { useSavedBrowserPreference } from './use-saved-browser-preference'

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
        "Open in this phone's system browser."
      )
    }
  ]
}

function drawingOptions(t: Translate): PickerOption<MobileBrowserDrawing>[] {
  return [
    {
      value: 'stream',
      label: t('settings.browserSettingsScreen.streamDrawing', 'Stream from the host'),
      subtitle: t(
        'settings.browserSettingsScreen.streamDrawingDescription',
        "Show pictures of the desktop's browser; the phone button still draws a tab here."
      )
    },
    {
      value: 'host',
      label: t('settings.browserSettingsScreen.hostDrawing', 'Draw on the phone, through the host'),
      subtitle: t(
        'settings.browserSettingsScreen.hostNetworkDescription',
        'Traffic goes out from your paired desktop, using its network and proxy settings.'
      )
    },
    {
      value: 'phone',
      label: t('settings.browserSettingsScreen.phoneDrawing', 'Draw on the phone, on its network'),
      subtitle: t(
        'settings.browserSettingsScreen.phoneNetworkDescription',
        'Traffic goes out from this phone, like any app on it.'
      )
    }
  ]
}

function optionLabel<T extends string>(value: T, options: PickerOption<T>[]): string {
  return options.find((option) => option.value === value)?.label ?? options[0]!.label
}

export default function BrowserSettingsScreen({
  onBack
}: {
  onBack?: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const router = useRouter()
  const [pickerOpen, setPickerOpen] = useState<'links' | 'drawing' | null>(null)
  const linkMode = useSavedBrowserPreference(
    loadLinkOpenMode,
    saveLinkOpenMode,
    DEFAULT_LINK_OPEN_MODE
  )
  const drawing = useSavedBrowserPreference(
    loadBrowserDrawing,
    saveBrowserDrawing,
    DEFAULT_BROWSER_DRAWING
  )
  const options = linkModeOptions(t)
  const drawings = drawingOptions(t)
  const error = linkMode.error ?? drawing.error

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
        <>
          <PickerModal<MobileLinkOpenMode>
            visible={pickerOpen === 'links'}
            title={t('settings.browserSettingsScreen.openLinks', 'Open links')}
            options={options}
            selected={linkMode.value}
            onSelect={linkMode.select}
            onClose={() => setPickerOpen(null)}
          />
          <PickerModal<MobileBrowserDrawing>
            visible={pickerOpen === 'drawing'}
            title={t('settings.browserSettingsScreen.showTabs', 'Show tabs')}
            options={drawings}
            selected={drawing.value}
            onSelect={drawing.select}
            onClose={() => setPickerOpen(null)}
          />
        </>
      }
    >
      <SettingsSection
        first
        title={t('settings.browserSettingsScreen.linksHeading', 'LINKS')}
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
          subtitle={optionLabel(linkMode.value, options)}
          leading={<Globe size={18} color={colors.textSecondary} />}
          navigates
          accessibilityLabel={t('settings.browserSettingsScreen.openLinks', 'Open links')}
          onPress={() => setPickerOpen('links')}
        />
      </SettingsSection>
      <SettingsSection
        title={t('settings.browserSettingsScreen.tabsHeading', 'BROWSER TABS')}
        footer={t(
          'settings.browserSettingsScreen.tabsDescription',
          'Choose how browser tabs show on the phone, and the network pages drawn here use.'
        )}
      >
        <ListRow
          key="drawing"
          title={t('settings.browserSettingsScreen.showTabs', 'Show tabs')}
          subtitle={optionLabel(drawing.value, drawings)}
          leading={<Network size={18} color={colors.textSecondary} />}
          navigates
          accessibilityLabel={t('settings.browserSettingsScreen.showTabs', 'Show tabs')}
          onPress={() => setPickerOpen('drawing')}
        />
      </SettingsSection>
    </SettingsScreen>
  )
}
