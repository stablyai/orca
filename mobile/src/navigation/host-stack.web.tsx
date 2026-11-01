import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Navigator, usePathname } from 'expo-router'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { HOST_STACK_SCREENS, type HostStackAnimation } from './host-stack-screens'
import { isOverlayPageRoute } from '../new-workspace/overlay-page-route'
import { runStackMotion } from './host-stack-motion.web'

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
  const nodes = useRef(new Map<string, HTMLElement>())

  // Derive during render so a pop’s first frame still contains its outgoing screen.
  if (shown.routes !== routes) {
    const moved = shown.routes.at(-1)?.key !== routes.at(-1)?.key
    const slides = moved && animation !== 'none'
    setShown({
      routes,
      descriptors,
      transition: !moved ? shown.transition : slides ? transitionBetween(shown, routes) : null
    })
  }

  const settle = useCallback(() => setShown((current) => ({ ...current, transition: null })), [])
  const { transition } = shown
  const topKey = routes.at(-1)?.key
  const underKey = transition?.kind === 'push' ? transition.underKey : null
  // Keep one keyed sibling list so moving the leaving screen to the end preserves its mount.
  const slots = transition?.kind === 'pop' ? [...routes, transition.leaving] : routes

  // Start before paint so screens never flash at rest before sliding.
  useLayoutEffect(() => {
    if (transition === null) {
      return
    }
    const push = transition.kind === 'push'
    return runStackMotion({
      kind: transition.kind,
      moving: nodes.current.get(push ? transition.enteringKey : transition.leaving.key) ?? null,
      under: nodes.current.get((push ? transition.underKey : topKey) ?? '') ?? null,
      reducedMotion: prefersReducedMotion(),
      onSettled: settle
    })
  }, [transition, topKey, settle])

  return (
    // Render descriptors bare like NavigatorSlot; NavigationContent cannot run in this view-only rerender.
    // Disable taps mid-slide so repeated row taps cannot push duplicate screens.
    <View style={styles.stack} pointerEvents={transition ? 'none' : 'auto'}>
      {slots.map((route) => {
        const leaving = transition?.kind === 'pop' && route.key === transition.leaving.key
        const descriptor = leaving ? transition.descriptors[route.key] : descriptors[route.key]
        return (
          <StackScreen
            key={route.key}
            routeKey={route.key}
            nodes={nodes.current}
            visible={route.key === topKey || leaving || route.key === underKey}
          >
            {descriptor?.render()}
          </StackScreen>
        )
      })}
    </View>
  )
}

function StackScreen({
  routeKey,
  nodes,
  visible,
  children
}: {
  routeKey: string
  nodes: Map<string, HTMLElement>
  visible: boolean
  children: ReactNode
}) {
  useMobileColorScheme()
  const transparent = isOverlayPageRoute(usePathname())
  return (
    <View
      ref={(view: unknown) => {
        if (view instanceof HTMLElement) {
          nodes.set(routeKey, view)
        } else {
          nodes.delete(routeKey)
        }
      }}
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
