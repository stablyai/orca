import { useEffect, useState } from 'react'
import { StyleSheet, Text } from 'react-native'
import { hostScreenStyles } from '../host-screen/host-screen-styles'
import { loadHosts } from '../transport/host-store'
import type { HostProfile } from '../transport/types'
import { useHostDisplay } from '../transport/use-host-display'

export function MobileTasksHostSubtitle({ hostId }: { hostId: string }) {
  const [host, setHost] = useState<HostProfile | null>(null)
  useEffect(() => {
    let stale = false
    setHost(null)
    loadHosts().then(
      (hosts) => {
        if (!stale) {
          setHost(hosts.find((profile) => profile.id === hostId) ?? null)
        }
      },
      () => {}
    )
    return () => {
      stale = true
    }
  }, [hostId])
  const title = useHostDisplay(host).title
  // Reserve the line before load to prevent a title jump; unknown hosts stay blank instead of showing generic Host.
  return (
    <Text
      style={[hostScreenStyles.hostPlatformText, styles.reserved]}
      numberOfLines={1}
      testID="mobile-tasks-host-subtitle"
    >
      {host ? title : ''}
    </Text>
  )
}

const styles = StyleSheet.create({
  reserved: { minHeight: hostScreenStyles.hostPlatformText.lineHeight }
})
