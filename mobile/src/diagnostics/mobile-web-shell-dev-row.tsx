import { useEffect, useState } from 'react'
import { Pressable, Switch, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { LayoutTemplate } from 'lucide-react-native'
import { loadHosts } from '../transport/host-store'
import { loadMobileWebShellEnabled, saveMobileWebShellEnabled } from '../storage/preferences'
import { colors } from '../theme/mobile-theme'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'

/**
 * Development-only: the one caller of `saveMobileWebShellEnabled`, and the one way into the hybrid
 * shell route that is not a deep link.
 *
 * `app/troubleshoot.tsx` mounts it behind `__DEV__`, exactly as it mounts A5's probe row, so a
 * shipped build never renders the toggle and the flag it guards can only stay off. The route itself
 * reads the flag again rather than trusting this screen, because a deep link arrives without it.
 */
export function MobileWebShellDevRow() {
  const router = useRouter()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [hostId, setHostId] = useState<string | null>(null)

  useEffect(() => {
    let stale = false
    void Promise.all([loadMobileWebShellEnabled(), loadHosts()]).then(([flag, hosts]) => {
      if (!stale) {
        setEnabled(flag)
        setHostId(hosts[0]?.id ?? null)
      }
    })
    return () => {
      stale = true
    }
  }, [])

  // Not while a write is in flight: the route reads the key back from storage, so a button that
  // opened on the switch's position would mount a shell the persisted flag does not permit yet.
  const openable = enabled === true && hostId !== null && !saving
  return (
    <View>
      <View style={styles.checkRow}>
        <Text style={styles.checkLabel}>Hybrid shell (dev)</Text>
        <Switch
          testID="mobile-web-shell-flag"
          value={enabled === true}
          disabled={enabled === null || saving}
          onValueChange={(next) => {
            setSaving(true)
            void saveMobileWebShellEnabled(next)
              .then(() => {
                setEnabled(next)
              })
              // A write that never landed leaves the previous position showing, because that is
              // still what the route will read.
              .catch(() => undefined)
              .finally(() => {
                setSaving(false)
              })
          }}
        />
      </View>
      <Pressable
        style={({ pressed }) => [
          styles.diagnosticButton,
          pressed && styles.diagnosticButtonPressed,
          !openable && styles.diagnosticButtonDisabled
        ]}
        testID="mobile-web-shell-open"
        disabled={!openable}
        onPress={() => {
          if (hostId !== null) {
            router.push(`/h/${hostId}/web`)
          }
        }}
      >
        <LayoutTemplate size={16} color={colors.textPrimary} />
        <Text style={styles.diagnosticButtonLabel}>
          Open hybrid shell for the first paired host
        </Text>
      </Pressable>
    </View>
  )
}
