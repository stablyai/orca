import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import { colors } from '../theme/mobile-theme'

type WorktreeStatus = 'working' | 'active' | 'permission' | 'done' | 'inactive'

const STATUS_COLORS: Record<WorktreeStatus, string> = {
  working: colors.statusGreen,
  active: colors.statusGreen,
  permission: colors.statusRed,
  done: '#38bdf8',
  inactive: '#666666'
}

export function AgentSpinner({ status }: { status: WorktreeStatus }) {
  const spinValue = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (status === 'working') {
      const animation = Animated.loop(
        Animated.timing(spinValue, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: true
        })
      )
      animation.start()
      return () => animation.stop()
    }
    spinValue.setValue(0)
  }, [status, spinValue])

  const color = STATUS_COLORS[status] ?? STATUS_COLORS.inactive

  if (status === 'working') {
    const rotate = spinValue.interpolate({
      inputRange: [0, 1],
      outputRange: ['0deg', '360deg']
    })
    return (
      <Animated.View style={[styles.spinner, { borderColor: color, transform: [{ rotate }] }]} />
    )
  }

  return <View style={[styles.dot, { backgroundColor: color }]} />
}

const styles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4
  },
  spinner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderTopColor: 'transparent'
  }
})
