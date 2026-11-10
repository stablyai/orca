// The Reanimated members BottomDrawer's option pager reads, for tests that hand-mock it. Slides settle at
// once, so a close unmounts its page in the same act.
export function reanimatedPagerStub() {
  return {
    default: { View: 'AnimatedView' },
    Easing: { bezier: () => (t: number) => t },
    ReduceMotion: { Never: 'never' },
    useReducedMotion: () => false,
    runOnJS:
      <Args extends unknown[]>(fn: (...args: Args) => void) =>
      (...args: Args) =>
        fn(...args),
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value }),
    withTiming: (to: number, _config: unknown, done?: (finished: boolean) => void) => {
      done?.(true)
      return to
    }
  }
}
