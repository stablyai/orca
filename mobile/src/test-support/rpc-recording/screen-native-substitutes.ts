import { useEffect } from 'react'
import { inertIconModule, inertNativeElements } from './inert-native-elements'
import { partialNativeModule } from './native-module-traps'

// List only native members recordings actually reach; trap all others so new device dependencies require an explicit decision.
// Views stay inert: no measured layout/navigation; pin density like other device inputs.
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

// Treat focus as mount and callback changes as refocus; unmount records cleanup, but blur-only behavior stays uncovered.
function useFocusEffect(effect: () => (() => void) | void): void {
  useEffect(effect, [effect])
}

// Pin the route like panel props; its current reader sends only parameterless repo.list.
const ROUTE = { hostId: 'host-1' }
function constantRoute(): typeof ROUTE {
  return ROUTE
}

const SAFE_AREA_INSETS = { top: 47, right: 0, bottom: 34, left: 0 }

const ABSOLUTE_FILL = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }

/** The same merge the real `flatten` does, and pure, so a screen reading one style sees it. */
function flattenStyle(style: unknown): unknown {
  if (!Array.isArray(style)) {
    return style ?? {}
  }
  return Object.assign({}, ...style.map((entry) => flattenStyle(entry)))
}

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
