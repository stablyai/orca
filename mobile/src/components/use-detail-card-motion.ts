import { useLayoutEffect, useState, type RefObject } from 'react'
import { Animated, Easing, type HostInstance } from 'react-native'
import { commitDetailCardExit } from './detail-card-host'

export type DetailCardMotionOptions = {
  contentRef: RefObject<HostInstance | null>
  motion: number
  target: 0 | 1
  slide: boolean
  offset: number
  duration: number
  onSettled: (motion: number) => void
}

export function useDetailCardMotion({
  motion,
  target,
  slide,
  offset,
  duration,
  onSettled
}: DetailCardMotionOptions) {
  const [progress] = useState(() => new Animated.Value(0))
  useLayoutEffect(() => {
    let disposed = false
    progress.stopAnimation((value) => {
      if (disposed) {
        return
      }
      if (target === 0 && value === 0) {
        onSettled(motion)
        return
      }
      Animated.timing(progress, {
        toValue: target,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }).start(({ finished }) => {
        if (!disposed && finished && target === 0) {
          commitDetailCardExit(() => onSettled(motion))
        }
      })
    })
    return () => {
      disposed = true
      progress.stopAnimation()
    }
  }, [motion, target, progress, duration, onSettled])
  return {
    opacity: progress,
    transform: slide
      ? [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }) }]
      : []
  }
}
