// What animated chat controls (and the composer's announcements) read from react-native, for tests that hand-mock it. Timings finish at
// once, so a test sees each control at rest.
export function reactNativeMotionStub() {
  class Value {
    constructor(public value: number) {}
    setValue(value: number): void {
      this.value = value
    }
    interpolate(): this {
      return this
    }
    stopAnimation(): void {}
  }
  const curve = (t: number) => t
  const shaped = (easing: (t: number) => number) => easing
  return {
    BackHandler: {
      addEventListener: () => ({ remove: () => {} })
    },
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(false),
      addEventListener: () => ({ remove: () => {} }),
      announceForAccessibilityWithOptions: () => {}
    },
    Animated: {
      Value,
      View: 'Animated.View',
      multiply: (left: Value) => left,
      parallel: (
        animations: {
          start: (done?: (result: { finished: boolean }) => void) => void
          stop: () => void
        }[]
      ) => ({
        start: (done?: (result: { finished: boolean }) => void) => {
          for (const animation of animations) {
            animation.start()
          }
          done?.({ finished: true })
        },
        stop: () => {
          for (const animation of animations) {
            animation.stop()
          }
        }
      }),
      spring: () => ({
        start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
        stop: () => {}
      }),
      timing: () => ({
        start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
        stop: () => {}
      })
    },
    Easing: {
      bezier: () => curve,
      cubic: curve,
      ease: curve,
      in: shaped,
      inOut: shaped,
      out: shaped
    },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 1 })
  }
}
