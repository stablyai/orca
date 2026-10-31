import type * as ReactModule from 'react'
import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import type Animated from 'react-native-reanimated'
import { useAnimatedRef, useSharedValue } from 'react-native-reanimated'
import { afterEach, beforeEach, vi } from 'vitest'

type DragEvent = { absoluteY: number; translationY: number }
type GestureCallbacks = Record<string, (event: DragEvent, success: boolean) => void>
const probe = vi.hoisted(
  (): {
    copiedStateKeys: number
    layouts: { value: unknown; inputs: unknown[] }[]
    styleInputs: unknown[][]
    gestures: GestureCallbacks[]
    shared: { value: unknown }[]
    frameActive: ReturnType<typeof vi.fn>
    deferJS: boolean
    jsQueue: (() => void)[]
    frame: ((frame: { timeSincePreviousFrame: number }) => void) | null
    scroll: ReturnType<typeof vi.fn>
    viewport: { pageY: number; height: number } | null
    reactions: Set<() => void>
    styles: Map<object, () => Record<string, unknown>>
    spring: ReturnType<typeof vi.fn>
    enabled: boolean[]
  } => ({
    copiedStateKeys: 0,
    layouts: [],
    styleInputs: [],
    gestures: [],
    shared: [],
    frameActive: vi.fn(),
    deferJS: false,
    jsQueue: [],
    frame: null,
    scroll: vi.fn(),
    viewport: null,
    reactions: new Set(),
    styles: new Map(),
    spring: vi.fn((value: number) => value),
    enabled: []
  })
)

vi.mock('react', async (importOriginal) => {
  const React = await importOriginal<typeof ReactModule>()
  return {
    ...React,
    useState: (initial: unknown) => {
      const [value, setValue] = React.useState(initial)
      return [
        value,
        (update: unknown) =>
          setValue((current: unknown) => {
            if (typeof update !== 'function') {
              return update
            }
            const source =
              current && typeof current === 'object' && !Array.isArray(current)
                ? new Proxy(current, {
                    ownKeys(target) {
                      const keys = Reflect.ownKeys(target)
                      probe.copiedStateKeys += keys.length
                      return keys
                    }
                  })
                : current
            const next = update(source)
            return next === source ? current : next
          })
      ]
    }
  }
})
const measurementFrames = new Map<number, FrameRequestCallback>()
let frameId = 0
async function publishLayout() {
  await act(async () => {
    const callbacks = [...measurementFrames.values()]
    measurementFrames.clear()
    callbacks.forEach((fn) => fn(0))
  })
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

vi.mock('react-native', async () => {
  const React = await import('react')
  const Host = ({ children, ...props }: { children?: ReactNode }) =>
    React.createElement('Host', props, children)
  return {
    Text: Host,
    Pressable: Host,
    Switch: Host,
    AppState: { addEventListener: () => ({ remove() {} }) },
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('react-native-gesture-handler', async () => {
  const React = await import('react')
  return {
    GestureDetector: ({ children }: { children: ReactNode }) =>
      React.createElement('GestureDetector', null, children),
    Gesture: {
      Pan: () => {
        const callbacks: GestureCallbacks = {}
        probe.gestures.push(callbacks)
        const gesture = {
          enabled: (enabled: boolean) => {
            probe.enabled.push(enabled)
            return gesture
          },
          activateAfterLongPress: () => gesture,
          shouldCancelWhenOutside: () => gesture,
          onStart: (fn: GestureCallbacks[string]) => {
            callbacks.start = fn
            return gesture
          },
          onUpdate: (fn: GestureCallbacks[string]) => {
            callbacks.update = fn
            return gesture
          },
          onFinalize: (fn: GestureCallbacks[string]) => {
            callbacks.finalize = fn
            return gesture
          }
        }
        return gesture
      }
    }
  }
})
vi.mock('react-native-reanimated', async () => {
  const React = await import('react')
  return {
    default: {
      View: ({ children, ...props }: { children?: ReactNode }) =>
        React.createElement('AnimatedView', props, children)
    },
    useSharedValue: (value: unknown) => {
      const held = React.useRef({ value })
      if (!probe.shared.includes(held.current)) {
        probe.shared.push(held.current)
      }
      return held.current
    },
    useAnimatedRef: () => React.useRef(Object.assign(() => null, { current: null })).current,
    useDerivedValue: (fn: () => unknown, inputs: unknown[]) => {
      const layout = React.useMemo(
        () => ({
          get value() {
            return fn()
          },
          inputs
        }),
        inputs
      )
      probe.layouts.push(layout)
      return layout
    },
    useAnimatedReaction: (
      prepare: () => unknown,
      react: (value: unknown, previous: unknown) => void
    ) => {
      const held = React.useRef<{
        prepare: () => unknown
        react: (value: unknown, previous: unknown) => void
        previous: unknown
      }>({ prepare, react, previous: null })
      held.current.prepare = prepare
      held.current.react = react
      React.useEffect(() => {
        const run = () => {
          const next = held.current.prepare()
          held.current.react(next, held.current.previous)
          held.current.previous = next
        }
        probe.reactions.add(run)
        return () => {
          probe.reactions.delete(run)
        }
      }, [])
    },
    useAnimatedStyle: (fn: () => Record<string, unknown>, inputs: unknown[]) => {
      probe.styleInputs.push(inputs)
      const key = React.useRef({})
      probe.styles.set(key.current, fn)
      React.useEffect(
        () => () => {
          probe.styles.delete(key.current)
        },
        []
      )
      return fn()
    },
    useFrameCallback: (fn: (frame: { timeSincePreviousFrame: number }) => void) => {
      probe.frame = fn
      return { setActive: probe.frameActive }
    },
    withSpring: probe.spring,
    runOnJS:
      (fn: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        if (probe.deferJS) {
          probe.jsQueue.push(() => fn(...args))
        } else {
          fn(...args)
        }
      },
    runOnUI: (fn: unknown) => fn,
    measure: () => probe.viewport,
    scrollTo: probe.scroll
  }
})
vi.mock('lucide-react-native', () => ({
  GripVertical: () => null,
  ChevronRight: () => null,
  X: () => null
}))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('./CustomKeyModal', () => ({ CustomKeyModal: () => null }))
vi.mock('./MobileSwitch', () => ({ MobileSwitch: 'Switch' }))
vi.mock('../layout/use-shell-side-rail', () => ({ useDirectionPadAvailable: () => false }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
vi.mock('../platform/haptics', () => ({ triggerMediumImpact: vi.fn(), triggerSelection: vi.fn() }))

import { DragReorderList } from './DragReorderList'

beforeEach(() => {
  probe.copiedStateKeys = 0
  measurementFrames.clear()
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((fn: FrameRequestCallback) => {
      measurementFrames.set(++frameId, fn)
      return frameId
    })
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => measurementFrames.delete(id))
  )
  probe.layouts.length = 0
  probe.styleInputs.length = 0
  probe.gestures.length = 0
  probe.shared.length = 0
  probe.frameActive.mockClear()
  probe.deferJS = false
  probe.jsQueue.length = 0
  probe.frame = null
  probe.scroll.mockClear()
  probe.viewport = null
  probe.spring.mockClear()
  probe.enabled.length = 0
})

async function mounted({
  initialIds = ['a', 'b'],
  canMove,
  onMove
}: {
  initialIds?: string[]
  canMove?: (item: { id: string }) => boolean
  onMove?: (move: { movedId: string } & ({ beforeId: string } | { afterId: string })) => void
} = {}) {
  const onReorder = vi.fn()
  const onActive = vi.fn()
  let root: ReturnType<typeof create>
  function Harness({ ids = initialIds }: { ids?: string[] }) {
    const scrollRef = useAnimatedRef<Animated.ScrollView>()
    const scrollOffsetY = useSharedValue(0)
    const scrollContentHeight = useSharedValue(144)
    return createElement(DragReorderList<{ id: string }>, {
      items: ids.map((id) => ({ id })),
      itemKey: (item) => item.id,
      canMove,
      rowHeight: 72,
      renderRow: (item, handle) => createElement('Text', null, item.id, handle),
      onReorder,
      onMove,
      onDragActiveChange: (active: boolean) => onActive(active),
      scrollRef,
      scrollOffsetY,
      scrollContentHeight
    })
  }
  await act(async () => {
    root = create(createElement(Harness))
  })
  return {
    root: root!,
    onReorder,
    onActive,
    gesture: probe.gestures[0]!,
    updateItems: async (ids: string[]) => {
      await act(async () => root!.update(createElement(Harness, { ids })))
    }
  }
}

function positions() {
  return probe.shared.findLast(
    (held) =>
      held.value &&
      typeof held.value === 'object' &&
      'a' in held.value &&
      typeof held.value.a === 'number' &&
      held.value.a >= 0 &&
      held.value.a < 3
  )!.value
}

export { probe, publishLayout, mounted, positions, measurementFrames }
