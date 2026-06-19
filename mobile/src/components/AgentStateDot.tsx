import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import type { AgentDotState } from '../worktree/agent-row-display'

// Per-agent state indicator, 1:1 with desktop AgentStateDot
// (src/renderer/src/components/AgentStateDot.tsx): yellow spinner for 'working',
// emerald for 'done', red for blocked/waiting/interrupted (attention), neutral
// for idle. Distinct from the worktree-level AgentSpinner, which collapses the
// agent vocabulary into the 5-state rollup the sidebar dot uses.
const DOT_COLORS: Record<Exclude<AgentDotState, 'working'>, string> = {
  done: '#10b981',
  blocked: '#ef4444',
  waiting: '#ef4444',
  interrupted: '#ef4444',
  idle: 'rgba(115,115,115,0.4)'
}

export function AgentStateDot({ state }: { state: AgentDotState }) {
  const spinValue = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (state === 'working') {
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
    return undefined
  }, [state, spinValue])

  if (state === 'working') {
    const rotate = spinValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })
    return (
      <View style={styles.wrapper}>
        <Animated.View style={[styles.spinner, { transform: [{ rotate }] }]} />
      </View>
    )
  }

  return (
    <View style={styles.wrapper}>
      <View style={[styles.dot, { backgroundColor: DOT_COLORS[state] }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: { width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  spinner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: '#eab308',
    borderTopColor: 'transparent'
  }
})
