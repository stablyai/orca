import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { Pressable, Text, View } from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { firstParam } from '../navigation/route-param-reader'
import { useRouteHandoff } from '../navigation/route-handoff'
import { useHostClient } from '../transport/host-client-hooks'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { useReachableServerClients } from '../worktree/use-reachable-server-clients'
import { colors } from '../theme/mobile-theme'
import { AutomationChoice } from './AutomationControls'
import { AutomationManager } from './AutomationManager'
import { automationStyles as styles } from './automation-styles'

export function MobileAutomationsScreen() {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  const { client } = useHostClient(hostId)
  const { hostCapabilities } = useHostProtocolGates()
  const { servers, serverClients } = useReachableServerClients(client, hostCapabilities)
  const [authority, setAuthority] = useState('paired')
  const selected = servers?.find((server) => server.hostId === authority)
  const selectedClient =
    authority === 'paired' ? client : selected ? (serverClients.get(selected.hostId) ?? null) : null
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('automations.mobile.back', 'Back')}
          onPress={() => router.back()}
          hitSlop={8}
        >
          <ChevronLeft size={22} color={colors.textPrimary} />
        </Pressable>
        <Text style={[styles.title, styles.grow]}>
          {t('automations.mobile.automations', 'Automations')}
        </Text>
      </View>
      {servers?.length || authority !== 'paired' ? (
        <View style={styles.header}>
          <View style={styles.grow}>
            <AutomationChoice
              label={t('automations.mobile.host', 'Host')}
              value={authority}
              options={[
                { value: 'paired', label: t('automations.mobile.pairedHost', 'Paired host') },
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
                    server.relay === 'ready'
                      ? undefined
                      : t('automations.mobile.unavailable', 'Unavailable'),
                  disabled: server.relay !== 'ready'
                }))
              ]}
              onSelect={setAuthority}
            />
          </View>
        </View>
      ) : null}
      <AutomationManager
        key={`${hostId}:${authority}`}
        hostId={hostId}
        client={selectedClient}
        executionHost={
          authority === 'paired' ? undefined : (normalizeExecutionHostId(authority) ?? undefined)
        }
      />
    </View>
  )
}
