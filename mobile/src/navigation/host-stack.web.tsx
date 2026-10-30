import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Navigator, usePathname } from 'expo-router'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { HOST_STACK_SCREENS, type HostStackAnimation } from './host-stack-screens'
import { isOverlayPageRoute } from '../new-workspace/overlay-page-route'
import { SideRailOnTopContext } from '../layout/side-rail'

// Expo native-stack’s web view ignores animation and switches display; reuse StackRouter with a view that retains popped screens through their exit slide.
export function HostStack({ animation }: { animation: HostStackAnimation }) {
  useMobileTranslation()
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
// Bound suspended-screen waits so a route with no content can still arrive.
const CONTENT_WAIT_CAP_MS = 1000
// Approximate iOS push timing so page/native transitions feel continuous.
const SLIDE_EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

type NavigatorContext = ReturnType<typeof Navigator.useContext>
type Descriptors = NavigatorContext['descriptors']
type Routes = NavigatorContext['state']['routes']

type Transition =
  | Readonly<{ kind: 'push'; enteringKey: string; underKey: string }>
  | Readonly<{ kind: 'pop'; leaving: Routes[number]; descriptors: Descriptors }>

type Shown = Readonly<{
  routes: Routes
  descriptors: Descriptors
  transition: Transition | null
}>

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function transitionBetween(previous: Shown, next: Routes): Transition | null {
  const previousTop = previous.routes.at(-1)
  const nextTop = next.at(-1)
  if (!previousTop || !nextTop || previousTop.key === nextTop.key) {
    return null
  }
  const nextKeys = next.map((route) => route.key)
  if (nextKeys.at(-2) === previousTop.key) {
    return { kind: 'push', enteringKey: nextTop.key, underKey: previousTop.key }
  }
  if (!nextKeys.includes(previousTop.key) && previous.routes.some((r) => r.key === nextTop.key)) {
    return { kind: 'pop', leaving: previousTop, descriptors: previous.descriptors }
  }
  return null
}

function HostStackView({ animation }: { animation: HostStackAnimation }) {
  useMobileColorScheme()
  const { state, descriptors } = Navigator.useContext()
  const { routes } = state
  const [shown, setShown] = useState<Shown>({ routes, descriptors, transition: null })

  // Derive during render so a pop’s first frame still contains its outgoing screen.
  if (shown.routes !== routes) {
    const moved = shown.routes.at(-1)?.key !== routes.at(-1)?.key
    const slides = moved && animation !== 'none' && !prefersReducedMotion()
    setShown({
      routes,
      descriptors,
      transition: !moved ? shown.transition : slides ? transitionBetween(shown, routes) : null
    })
  }

  const settle = useCallback(() => setShown((current) => ({ ...current, transition: null })), [])
  const { transition } = shown
  const topKey = routes.at(-1)?.key
  // Keep one keyed sibling list so moving the leaving screen to the end preserves its mount.
  const slots = transition?.kind === 'pop' ? [...routes, transition.leaving] : routes

  return (
    // Render descriptors bare like NavigatorSlot; NavigationContent cannot run in this view-only rerender.
    // Disable taps mid-slide so repeated row taps cannot push duplicate screens.
    <View style={styles.stack} pointerEvents={transition ? 'none' : 'auto'}>
      {slots.map((route) => {
        const leaving = transition?.kind === 'pop' && route.key === transition.leaving.key
        const entering = transition?.kind === 'push' && route.key === transition.enteringKey
        const under = transition?.kind === 'push' && route.key === transition.underKey
        const descriptor = leaving ? transition.descriptors[route.key] : descriptors[route.key]
        return (
          <StackScreen
            key={route.key}
            visible={route.key === topKey || leaving || under}
            motion={leaving ? 'exit' : entering ? 'enter' : null}
            onSettled={settle}
          >
            <SideRailOnTopContext.Provider value={route.key === topKey}>
              {descriptor?.render()}
            </SideRailOnTopContext.Provider>
          </StackScreen>
        )
      })}
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
  useMobileColorScheme()
  const ref = useRef<View>(null)
  const transparent = isOverlayPageRoute(usePathname())
  // Resume interrupted offsets when a pop reverses an unfinished push.
  const stoppedAt = useRef<string | null>(null)

  // Start before paint so screens never flash at rest before sliding.
  useLayoutEffect(() => {
    const from = stoppedAt.current
    stoppedAt.current = null
    const node: unknown = ref.current
    if (motion === null || !(node instanceof HTMLElement)) {
      return
    }
    const frames =
      motion === 'enter'
        ? [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }]
        : [{ transform: from ?? 'translateX(0)' }, { transform: 'translateX(100%)' }]
    // Use compositor animations so expensive screen mounts cannot stall slides.
    const slide = node.animate(frames, { duration: SLIDE_MS, easing: SLIDE_EASING, fill: 'both' })
    slide.onfinish = onSettled
    const stop = () => {
      stoppedAt.current = getComputedStyle(node).transform
      slide.cancel()
    }
    if (motion === 'exit' || node.childElementCount > 0) {
      return stop
    }
    // Keep suspended chunks off-screen until content commits so the slide cannot reveal an empty pane.
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
      stop()
    }
  }, [motion, onSettled])

  return (
    <View
      ref={ref}
      style={[styles.screen, transparent && styles.transparent, visible ? null : styles.hidden]}
    >
      {children}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  stack: {
    flex: 1,
    overflow: 'hidden'
  },
  screen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bgBase
  },
  transparent: {
    backgroundColor: 'transparent'
  },
  hidden: {
    display: 'none'
  }
}))
