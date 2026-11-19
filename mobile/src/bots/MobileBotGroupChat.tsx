import { useCallback, useState } from 'react'
import { View } from 'react-native'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useForceReconnect, useHostClient } from '../transport/connection/host-client-hooks'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { MobileOfflineState, MobileStateView } from '../components/feedback/MobileStateView'
import { groupStyles as styles } from './mobile-bot-group-styles'
import { MobileBotGroupRoom } from './MobileBotGroupRoom'

export function MobileBotGroupChat() {
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const forceReconnect = useForceReconnect()
  const params = useLocalSearchParams<{ hostId: string; groupId: string }>()
  const { client, state } = useHostClient(params.hostId)
  if (client && state === 'connected') {
    return (
      <MobileBotGroupRoom
        key={`${params.hostId}:${params.groupId}`}
        client={client}
        groupId={params.groupId}
        hostId={params.hostId}
        visible={focused}
      />
    )
  }
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel={t('bots.groups.back', 'Back')}
            onPress={() => router.back()}
          />
        }
        title={t('bots.groups.group', 'Group')}
      />
      {state === 'connecting' || state === 'handshaking' ? (
        <MobileStateView loading title={t('common.connectingToHost', 'Connecting to host…')} />
      ) : (
        <MobileOfflineState
          onReconnect={forceReconnect ? () => void forceReconnect(params.hostId) : null}
        />
      )}
    </View>
  )
}
