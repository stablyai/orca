import { useEffect, useRef } from 'react'
import { Animated, Easing, View } from 'react-native'
import { useReducedMotionEnabled } from '../platform/use-reduced-motion'
import { colors, radii } from '../theme/mobile-theme'
import type { CloudWorkspaceStatus } from './cloud-control-plane-client'
import { cloudStatusColor, isCloudStatusTransitional } from './cloud-workspace-display'

/** A status dot that breathes while the workspace changes state (still under Reduce Motion). */
export function CloudStatusDot({
  status,
  size = 10,
  warn = false
}: {
  status: CloudWorkspaceStatus
  size?: number
  /** Filled amber, still: running but unreachable (matches a desktop that can't connect). */
  warn?: boolean
}) {
  const reducedMotion = useReducedMotionEnabled() !== false
  const pulse = useRef(new Animated.Value(1)).current
  const moving = isCloudStatusTransitional(status) && !reducedMotion && !warn
  useEffect(() => {
    if (!moving) {
      // Settle to full opacity: a loop stopped mid-breath must not leave a dim dot behind.
      Animated.timing(pulse, { toValue: 1, duration: 150, useNativeDriver: true }).start()
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true
        })
      ])
    )
    loop.start()
    return () => loop.stop()
  }, [moving, pulse])
  const color = warn ? colors.statusAmber : cloudStatusColor(status)
  // Shapes, not only colors (glossary CloudStateDot): filled running, half waking, hollow asleep,
  // square archived, so state reads without color too.
  const half = isCloudStatusTransitional(status) && !warn
  const shape = warn
    ? { backgroundColor: color }
    : half
      ? {}
      : status === 'sleeping'
        ? { borderWidth: 1.5, borderColor: color }
        : status === 'archived'
          ? { borderRadius: radii.mark / 2, backgroundColor: color }
          : { backgroundColor: color }
  return (
    <Animated.View
      importantForAccessibility="no"
      style={[
        { width: size, height: size, borderRadius: radii.pill, overflow: 'hidden', opacity: pulse },
        shape
      ]}
    >
      {half ? (
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            borderRadius: radii.pill,
            borderWidth: 1.5,
            borderColor: color
          }}
        >
          <View style={{ flex: 1, backgroundColor: color }} />
          <View style={{ flex: 1 }} />
        </View>
      ) : null}
    </Animated.View>
  )
}
