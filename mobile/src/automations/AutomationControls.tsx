import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ReactNode } from 'react'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { Plus } from 'lucide-react-native'
import { describeLoadError } from '../components/feedback/load-error-description'
import { MobileLoadErrorState } from '../components/feedback/MobileStateView'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { SettingsNote } from '../settings/settings-screen-frame'
import { ListGroup } from '../components/list/ListGroup'
import { automationHostOutdated } from './automation-error'
import { automationStylesSheet as stylesSheet } from './automation-styles'
import { useThemedStyles } from '../theme/themed-styles'
import { HostUpdateNotice } from '../host-update-notice/HostUpdateNotice'

export type AutomationHeaderBar = {
  /** On an automation's page: its name, next run and the way back to the list, in place of the tabs. */
  page?: { title: string; subtitle: string; onBack: () => void }
  trailing?: ReactNode
}

/** The list's bar button that starts a new automation. */
export function AutomationNewButton(props: { disabled: boolean; onPress: () => void }) {
  const t = useMobileTranslation()
  return (
    <NavBarButton
      icon={Plus}
      accessibilityLabel={t('automations.mobile.newAutomation', 'New automation')}
      onPress={props.onPress}
      disabled={props.disabled}
    />
  )
}

/** Above the content: offline, a failed action, or a list that never loaded. */
export function AutomationCatalogNotes(props: {
  connected: boolean
  error: string | null
  failedLoad: boolean
  onRetry: (() => void) | null
}) {
  const t = useMobileTranslation()
  return (
    <>
      {!props.connected ? (
        <SettingsNote>
          {t('automations.mobile.offlineSaved', 'Offline. Showing saved automations.')}
        </SettingsNote>
      ) : null}
      {automationHostOutdated(props.error, t) ? (
        <ListGroup>
          <HostUpdateNotice
            variant="row"
            feature={t('automations.mobile.needsNewerOrca', 'Needed to run automations here')}
          />
        </ListGroup>
      ) : props.failedLoad ? (
        <MobileLoadErrorState error={props.error} onRetry={props.onRetry} />
      ) : props.error ? (
        <SettingsNote error>{describeLoadError(props.error, t).message}</SettingsNote>
      ) : null}
    </>
  )
}

// The bar's Automations / Runs switch, inset like Source Control's.
export function AutomationTabs(props: {
  selected: 'automations' | 'runs'
  onSelect: (tab: 'automations' | 'runs') => void
  disabled: boolean
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  return (
    <MobileSegmentedControl
      fill
      tabs
      style={styles.tabs}
      segments={[
        { value: 'automations', label: t('automations.mobile.automations', 'Automations') },
        { value: 'runs', label: t('automations.mobile.runs', 'Runs') }
      ]}
      selected={props.selected}
      onSelect={props.onSelect}
      disabled={props.disabled}
    />
  )
}
