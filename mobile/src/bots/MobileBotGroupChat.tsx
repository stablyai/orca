import { useCallback, useState } from 'react'
import { Text, View } from 'react-native'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useHostClient } from '../transport/connection/host-client-hooks'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
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
  const params = useLocalSearchParams<{ hostId: string; groupId: string }>()
  const { client, state } = useHostClient(params.hostId)
  return client && state === 'connected' ? (
    <MobileBotGroupRoom
      key={`${params.hostId}:${params.groupId}`}
      client={client}
      groupId={params.groupId}
      hostId={params.hostId}
      visible={focused}
    />
  ) : (
    <View style={styles.screen}>
      <Text style={styles.notice}>
        {t(
          'bots.groups.connectToTheExecutionHostToOpenThisGroup',
          'Connect to the execution host to open this group.'
        )}
      </Text>
    </View>
  )
}
