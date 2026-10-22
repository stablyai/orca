import { useEffect, useState } from 'react'
import { StyleSheet, Text } from 'react-native'
import { hostScreenStyles } from '../host-screen/host-screen-styles'
import { loadHosts } from '../transport/host-store'
import type { HostProfile } from '../transport/types'
import { useHostDisplay } from '../transport/use-host-display'

/** The desktop these tasks belong to, in the host screen's subtitle line. */
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
      // An unreadable profile leaves the line blank; the screen itself reports connection trouble.
      () => {}
    )
    return () => {
      stale = true
    }
  }, [hostId])
  const title = useHostDisplay(host).title
  // The line is reserved before the read so the title does not jump; it stays blank for an
  // unknown host, which would otherwise show the generic "Host".
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
