import { useCallback, useState, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useForceReconnect, useHostClient } from '../transport/connection/host-client-hooks'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { NATIVE_SCREEN_HEADER, ScreenHeader } from '../components/nav-bar/ScreenHeader'
import { MobileOfflineState, MobileStateView } from '../components/feedback/MobileStateView'
import { groupStyles as styles } from './mobile-bot-group-styles'
import { useHostConnectionInputs } from '../transport/connection/client-context-connection-metrics'
import { classifyConnection } from '../transport/connection/connection-health'
import { useHostProfile } from '../host-catalog/use-host-profile'
import { useHostDisplay } from '../host-descriptors/use-host-display'
import { useSettledMobileNativeChatInputLock } from '../session/native-chat/composer/field/use-mobile-native-chat-input-lease'
import { mobileNativeChatHostOutage } from '../session/native-chat/status/mobile-native-chat-host-outage'
import { MobileBotGroupRoom } from './MobileBotGroupRoom'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { keptHomeComputers, subscribeKeptHomeComputers } from '../home/bots/kept-home-computers'

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
  const connected = client !== null && state === 'connected'
  // Once open, the room outlasts an outage and Reconnect's new client, keeping its transcript as a chat does.
  const room = `${params.hostId}:${params.groupId}`
  const [opened, setOpened] = useState<{ room: string; client: RpcClient } | null>(null)
  if (client && connected && (opened?.room !== room || opened.client !== client)) {
    setOpened({ room, client })
  } else if (state === 'auth-failed' && opened) {
    // A revoked phone keeps nothing it read, as the host's cache wipe does.
    setOpened(null)
  }
  const roomClient = opened?.room === room ? (client ?? opened.client) : null
  // The chat's outage line, after the same settle, so a self-healing blip never shows.
  const locked = useSettledMobileNativeChatInputLock(connected ? null : 'disconnected') !== null
  const connectionInputs = useHostConnectionInputs(params.hostId)
  const hostName = useHostDisplay(useHostProfile(params.hostId)).title
  const outage = locked
    ? mobileNativeChatHostOutage(
        {
          pairedHostState: state,
          pairedVerdict: classifyConnection({ state, ...connectionInputs }),
          hostName,
          reconnect: forceReconnect ? () => void forceReconnect(params.hostId) : null
        },
        t
      )
    : null
  const keptName = useSyncExternalStore(
    subscribeKeptHomeComputers,
    () =>
      keptHomeComputers()
        .get(params.hostId)
        ?.kept?.groups.find((group) => group.id === params.groupId)?.name
  )
  if (roomClient) {
    return (
      <MobileBotGroupRoom
        key={room}
        client={roomClient}
        connected={connected}
        outage={outage}
        groupId={params.groupId}
        hostId={params.hostId}
        hostName={hostName}
        visible={focused}
      />
    )
  }
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: NATIVE_SCREEN_HEADER ? 0 : insets.top, paddingBottom: insets.bottom }
      ]}
    >
      <ScreenHeader
        title={keptName ?? t('bots.groups.group', 'Group')}
        onBack={() => router.back()}
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
