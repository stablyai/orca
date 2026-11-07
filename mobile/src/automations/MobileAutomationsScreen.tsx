import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useRef, useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { firstParam } from '../navigation/route-param-reader'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useHostClient } from '../transport/host-client-hooks'
import { useHostDisplay } from '../transport/use-host-display'
import { useHostProfile } from '../transport/use-host-profile'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { NavBar, NavBarTitleButton } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PickerModal, type PickerOption } from '../components/PickerModal'
import { useBottomDrawerFollowUp } from '../components/bottom-drawer/use-bottom-drawer-follow-up'
import { useReachableServerClients } from '../worktree/use-reachable-server-clients'
import { AutomationManager } from './AutomationManager'
import { leaveThrough, type AutomationLeaveGuard } from './AutomationEditorNavigation'
import { automationStyles as styles } from './automation-styles'

export function MobileAutomationsScreen() {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const params = useLocalSearchParams<{ hostId?: string | string[]; new?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  // Spent once the user picks another host, so switching back doesn't reopen the editor.
  const [creating, setCreating] = useState(firstParam(params.new) === '1')
  const { client } = useHostClient(hostId)
  const { hostCapabilities } = useHostProtocolGates()
  const { servers, serverClients } = useReachableServerClients(client, hostCapabilities)
  const host = useHostProfile(hostId)
  const hostTitle = useHostDisplay(host).title
  const [authority, setAuthority] = useState('paired')
  const [pickingHost, setPickingHost] = useState(false)
  const leaveGuard = useRef<AutomationLeaveGuard | null>(null)
  // A discard prompt may follow, so switch once the picker's sheet is gone.
  const hostPicker = useBottomDrawerFollowUp(() => setPickingHost(false))
  const selected = servers?.find((server) => server.hostId === authority)
  const selectedClient =
    authority === 'paired' ? client : selected ? (serverClients.get(selected.hostId) ?? null) : null
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const hostOptions: PickerOption[] = [
    {
      value: 'paired',
      label: (host && hostTitle) || t('automations.mobile.pairedHost', 'Paired host')
    },
    ...(authority !== 'paired' && !selected
      ? [
          {
            value: authority,
            label: t(
              'automations.mobile.selectedServerUnavailable',
              'Selected server (unavailable)'
            ),
            disabled: true
          }
        ]
      : []),
    ...(servers ?? []).map((server) => ({
      value: server.hostId,
      label: server.label,
      subtitle:
        server.relay === 'ready' ? undefined : t('automations.mobile.unavailable', 'Unavailable'),
      disabled: server.relay !== 'ready'
    }))
  ]
  const title = t('automations.mobile.automations', 'Automations')
  // Keep the subtitle line blank, not generic, until the paired host's name loads.
  const hostLabel =
    authority === 'paired'
      ? host
        ? hostTitle
        : ''
      : hostOptions.find((option) => option.value === authority)?.label
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <AutomationManager
        key={`${hostId}:${authority}`}
        hostId={hostId}
        client={selectedClient}
        startInEditor={creating}
        leaveGuard={leaveGuard}
        executionHost={
          authority === 'paired' ? undefined : (normalizeExecutionHostId(authority) ?? undefined)
        }
        renderHeader={(tabs) => (
          <NavBar
            leading={
              <NavBarButton
                icon={ChevronLeft}
                accessibilityLabel={t('automations.mobile.back', 'Back')}
                onPress={() => router.back()}
              />
            }
            title={title}
            subtitle={hostLabel}
            center={
              hostOptions.length > 1 ? (
                <NavBarTitleButton
                  title={title}
                  subtitle={hostLabel}
                  onPress={() => setPickingHost(true)}
                  accessibilityLabel={t(
                    'automations.mobile.chooseHost',
                    'Automations on {{host}}, choose another host',
                    { host: hostLabel }
                  )}
                />
              ) : undefined
            }
            accessory={tabs}
          />
        )}
      />
      <PickerModal
        visible={pickingHost}
        title={t('automations.mobile.host', 'Host')}
        options={hostOptions}
        selected={authority}
        onSelect={(next) => {
          if (next !== authority) {
            hostPicker.closeThen(() =>
              leaveThrough(leaveGuard, () => {
                setCreating(false)
                setAuthority(next)
              })
            )
          }
        }}
        {...hostPicker.drawerProps}
        searchable={hostOptions.length > 6}
      />
    </View>
  )
}
