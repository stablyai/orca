import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Navigator } from 'expo-router'
import { colors } from '../theme/mobile-theme'
import { HOST_STACK_SCREENS, type HostStackAnimation } from './host-stack-screens'

/**
 * Web sibling: the page's host stack, with the push and pop slide the native stack has.
 *
 * expo-router's `Stack` renders native-stack's web view on the page, which flips each screen's
 * `display` and ignores `animation`. This is the same expo-router `StackRouter` under the public
 * `Navigator`, with a view that keeps a popped screen mounted until it has slid out.
 */
export function HostStack({ animation }: { animation: HostStackAnimation }) {
  return (
    <Navigator>
      {HOST_STACK_SCREENS.map(({ name, title }) => (
        <Navigator.Screen key={name} name={name} options={{ title }} />
      ))}
      <HostStackView animation={animation} />
    </Navigator>
  )
}

const SLIDE_MS = 300
// Bounds the wait for a suspended screen, so a route that renders nothing still arrives.
const CONTENT_WAIT_CAP_MS = 1000
// Close to iOS's push curve, so the page and the native stack read as one motion.
const SLIDE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

type NavigatorContext = ReturnType<typeof Navigator.useContext>
type Descriptors = NavigatorContext['descriptors']
type Routes = NavigatorContext['state']['routes']

type Transition = Readonly<{
  kind: 'push' | 'pop'
  /** The entering screen on push, the leaving one on pop. */
  movingKey: string
  /** The screen that stays visible beneath the moving one. */
  underKey: string
}>

type Shown = Readonly<{
  /** The navigator's own routes array, whose identity changes exactly when the state does. */
  routes: Routes
  descriptors: Descriptors
  transition: Transition | null
  /** On pop, the route that left the state and stays mounted until its slide ends. */
  leaving: Readonly<{ route: Routes[number]; descriptors: Descriptors }> | null
}>

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Push = the old top is still in the stack below the new one; pop = the old top left it. */
function transitionBetween(previous: Routes, next: Routes): Transition | null {
  const previousTop = previous.at(-1)
  const nextTop = next.at(-1)
  if (!previousTop || !nextTop || previousTop.key === nextTop.key) {
    return null
  }
  const nextKeys = next.map((route) => route.key)
  if (nextKeys.at(-2) === previousTop.key) {
    return { kind: 'push', movingKey: nextTop.key, underKey: previousTop.key }
  }
  const previousKeys = previous.map((route) => route.key)
  if (!nextKeys.includes(previousTop.key) && previousKeys.includes(nextTop.key)) {
    return { kind: 'pop', movingKey: previousTop.key, underKey: nextTop.key }
  }
  // A replace or a reset has no direction to slide in.
  return null
}

function HostStackView({ animation }: { animation: HostStackAnimation }) {
  const { state, descriptors } = Navigator.useContext()
  const { routes } = state
  const [shown, setShown] = useState<Shown>({
    routes,
    descriptors,
    transition: null,
    leaving: null
  })

  // Derived during render, so the first painted frame of a pop still holds the leaving screen.
  if (shown.routes !== routes) {
    const animates = animation !== 'none' && !prefersReducedMotion()
    const moved = shown.routes.at(-1)?.key !== routes.at(-1)?.key
    const transition = !moved
      ? shown.transition
      : animates
        ? transitionBetween(shown.routes, routes)
        : null
    const leavingRoute = moved && transition?.kind === 'pop' ? shown.routes.at(-1) : undefined
    setShown({
      routes,
      descriptors,
      transition,
      leaving: leavingRoute
        ? { route: leavingRoute, descriptors: shown.descriptors }
        : moved
          ? null
          : shown.leaving
    })
  }

  const { transition, leaving } = shown
  const topKey = routes[state.index]?.key
  const settle = () => setShown((current) => ({ ...current, transition: null, leaving: null }))

  return (
    // No NavigationContent: it must render in the navigator's own pass, and a settle re-renders
    // only this view. expo-router's NavigatorSlot renders descriptors bare for the same reason.
    <View style={styles.stack}>
      {state.routes.map((route) => (
        <StackScreen
          key={route.key}
          visible={route.key === topKey || route.key === transition?.underKey}
          motion={
            transition?.kind === 'push' && transition.movingKey === route.key ? 'enter' : null
          }
          onSettled={settle}
        >
          {descriptors[route.key]?.render()}
        </StackScreen>
      ))}
      {leaving ? (
        <StackScreen key={leaving.route.key} visible motion="exit" onSettled={settle}>
          {leaving.descriptors[leaving.route.key]?.render()}
        </StackScreen>
      ) : null}
    </View>
  )
}

function StackScreen({
  visible,
  motion,
  onSettled,
  children
}: {
  visible: boolean
  motion: 'enter' | 'exit' | null
  onSettled: () => void
  children: ReactNode
}) {
  const ref = useRef<View>(null)
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled

  // Before paint, so neither screen is ever painted at rest before its slide starts.
  useLayoutEffect(() => {
    const node: unknown = ref.current
    if (motion === null || !(node instanceof HTMLElement)) {
      return
    }
    const frames =
      motion === 'enter'
        ? [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }]
        : [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }]
    // Web Animations run on the compositor, so a heavy screen mounting does not stall the slide.
    const slide = node.animate(frames, { duration: SLIDE_MS, easing: SLIDE_EASING, fill: 'both' })
    slide.onfinish = () => onSettledRef.current()
    if (motion === 'exit' || node.childElementCount > 0) {
      return () => slide.cancel()
    }
    // A route whose chunk is still loading suspends to an empty screen: hold it off-screen until
    // its content commits, so the slide carries the screen and not a blank panel.
    slide.pause()
    const start = () => {
      observer.disconnect()
      clearTimeout(cap)
      slide.play()
    }
    const observer = new MutationObserver(start)
    observer.observe(node, { childList: true, subtree: true })
    const cap = setTimeout(start, CONTENT_WAIT_CAP_MS)
    return () => {
      observer.disconnect()
      clearTimeout(cap)
      slide.cancel()
    }
  }, [motion])

  return (
    <View
      ref={ref}
      pointerEvents={motion === 'exit' ? 'none' : 'auto'}
      style={[styles.screen, visible ? null : styles.hidden]}
    >
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: {
    flex: 1,
    overflow: 'hidden'
  },
  screen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bgBase
  },
  hidden: {
    display: 'none'
  }
})
