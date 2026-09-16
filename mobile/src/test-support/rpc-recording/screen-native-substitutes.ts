import { useEffect } from 'react'
import { inertIconModule, inertNativeElements } from './inert-native-elements'
import { partialNativeModule } from './native-module-traps'

/**
 * The view packages a mounted screen imports, and what it gets instead.
 *
 * Every element here is inert (see `inert-native-elements.ts`) and every member follows the table's
 * rule: only what a recording is known to read is listed, and the rest throws — `native-module-traps.ts`
 * has the refusal and the `__esModule` exemption. A screen is mounted to observe the requests it
 * sends and the state it publishes, so nothing below simulates a device: no layout is measured and
 * no navigation happens. What a recording needs from any of them is that the render completes.
 *
 * Nothing is provisioned ahead of a reader, which is the point. A member listed before a recording
 * reads it turns a refusal that would have forced a decision into a silent stand-in, so a screen
 * reaching for an animation, a gesture or another primitive gets the named refusal instead, and
 * whoever mounts it adds the member here together with the recording that reads it.
 *
 * `hairlineWidth` is the one device input pinned rather than refused, for the same reason the window
 * size is: a pixel density is a pixel density, and a recording fixes it instead of reading it.
 */
export function screenNativeSubstitutes(): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      'react-native-safe-area-context',
      partialNativeModule('react-native-safe-area-context', {
        ...inertNativeElements(['SafeAreaView']),
        useSafeAreaInsets: () => SAFE_AREA_INSETS
      })
    ],
    [
      'expo-router',
      // One router per recording, so a screen that closes over it keeps a stable callback.
      partialNativeModule('expo-router', {
        useRouter: constantRouter,
        useFocusEffect,
        useLocalSearchParams: constantRoute
      })
    ],
    ['lucide-react-native', inertIconModule()]
  ])
}

const ROUTER = { push: () => {}, replace: () => {}, back: () => {}, dismiss: () => {} }
function constantRouter(): typeof ROUTER {
  return ROUTER
}

/**
 * Focus as mount. The real hook runs its effect on focus and re-runs it when the callback identity
 * changes, which is what a mounted-and-focused screen does here — so a route's focus cleanup is
 * recorded at unmount. Blur is not: nothing drives this substitute, so an unsubscribe that only a
 * blur would reach stays unrecorded, and the README says so rather than a listener implying it.
 */
function useFocusEffect(effect: () => (() => void) | void): void {
  useEffect(effect, [effect])
}

/**
 * The route one recording runs on, pinned for the same reason the window size is: a screen's own
 * address is not a device reading, and for a route screen it is what the props are for a panel an
 * adapter mounts directly. It shapes no recorded parameter — the one screen that reads it sends
 * `repo.list`, which takes none (`tasks.route-repo-list`).
 */
const ROUTE = { hostId: 'host-1' }
function constantRoute(): typeof ROUTE {
  return ROUTE
}

/** A phone's insets, fixed the way the window size is. Nothing here is measured. */
const SAFE_AREA_INSETS = { top: 47, right: 0, bottom: 34, left: 0 }

const ABSOLUTE_FILL = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }

/** The same merge the real `flatten` does, and pure, so a screen reading one style sees it. */
function flattenStyle(style: unknown): unknown {
  if (!Array.isArray(style)) {
    return style ?? {}
  }
  return Object.assign({}, ...style.map((entry) => flattenStyle(entry)))
}

/** The react-native primitives and module members a mounted screen reads. */
export function reactNativeScreenMembers(): Record<string, unknown> {
  return {
    ...inertNativeElements([
      'ActivityIndicator',
      'FlatList',
      'Pressable',
      'RefreshControl',
      'SectionList',
      'Text',
      'TextInput',
      'View'
    ]),
    StyleSheet: {
      create: (sheet: unknown) => sheet,
      flatten: flattenStyle,
      hairlineWidth: 1,
      absoluteFill: ABSOLUTE_FILL,
      absoluteFillObject: ABSOLUTE_FILL
    }
  }
}
