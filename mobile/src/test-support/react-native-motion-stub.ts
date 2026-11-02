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
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(false),
      addEventListener: () => ({ remove: () => {} }),
      announceForAccessibilityWithOptions: () => {}
    },
    Animated: {
      Value,
      View: 'Animated.View',
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
    }
  }
}
