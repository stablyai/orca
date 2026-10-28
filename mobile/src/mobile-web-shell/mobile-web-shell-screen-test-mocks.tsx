// Register these factories in each suite so split screen tests use the same environment.
import * as React from 'react'
import { vi } from 'vitest'
import { parseMobileWebShellLoadState } from '../../modules/orca-mobile-web-shell/src/load-state'
import { SCREEN_SNAPSHOT, type ScreenDependencies } from './mobile-web-shell-screen-test-harness'

export function screenModuleMocks(dependencies: ScreenDependencies) {
  return {
    'react-native': () => ({
      ActivityIndicator: 'ActivityIndicator',
      AccessibilityInfo: {
        isReduceMotionEnabled: () => Promise.resolve(false),
        addEventListener: () => ({ remove: () => {} })
      },
      Easing: { in: (fn: unknown) => fn, out: (fn: unknown) => fn, quad: 'quad' },
      // Finish animations immediately so cover/bar state can be asserted without testing visual motion.
      Animated: {
        View: 'Animated.View',
        Value: class {
          constructor(public value: number) {}
          setValue(value: number): void {
            this.value = value
          }
        },
        timing: (value: { setValue: (next: number) => void }, config: { toValue: number }) => ({
          start: (done?: (result: { finished: boolean }) => void) => {
            value.setValue(config.toValue)
            done?.({ finished: true })
          },
          stop: () => {}
        })
      },
      BackHandler: {
        addEventListener: (name: string, listener: () => boolean) => {
          dependencies.backHandlers.set(name, listener)
          return { remove: () => dependencies.backHandlers.delete(name) }
        }
      },
      Keyboard: {
        addListener: (
          name: string,
          listener: (event: { endCoordinates: { height: number } }) => void
        ) => {
          dependencies.keyboardListeners.set(name, listener)
          return { remove: () => dependencies.keyboardListeners.delete(name) }
        }
      },
      Linking: { openURL: dependencies.openUrl },
      Platform: {
        get OS() {
          return dependencies.platform
        }
      },
      Pressable: 'Pressable',
      StyleSheet: {
        create: (styles: unknown) => styles,
        absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
      },
      Text: 'Text',
      View: 'View',
      useWindowDimensions: () => ({ width: 390, height: 844 })
    }),
    // Stub Expo-dependent native handlers; native-clipboard.test.ts covers their behavior.
    'expo-clipboard': () => ({
      setStringAsync: () => Promise.resolve(true),
      getStringAsync: () => Promise.resolve('')
    }),
    // Stub Expo haptics; page-haptics.test.ts covers dispatch. Pinned iOS means Android members are never evaluated.
    'expo-haptics': () => ({
      impactAsync: () => Promise.resolve(),
      notificationAsync: () => Promise.resolve(),
      selectionAsync: () => Promise.resolve(),
      ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
      NotificationFeedbackType: { Error: 'error', Success: 'success' }
    }),
    'expo-document-picker': () => ({ getDocumentAsync: () => Promise.resolve(null) }),
    '@orca/expo-two-way-audio': () => ({
      addExpoTwoWayAudioEventListener: () => ({ remove: () => {} }),
      initialize: () => Promise.resolve(true),
      requestMicrophonePermissionsAsync: () =>
        Promise.resolve({ granted: true, canAskAgain: true, status: 'granted', expires: 'never' }),
      tearDown: () => {},
      toggleRecording: () => true
    }),
    'expo-keep-awake': () => ({
      activateKeepAwakeAsync: () => Promise.resolve(),
      deactivateKeepAwake: () => Promise.resolve()
    }),
    'expo-image-picker': () => ({
      launchImageLibraryAsync: () => Promise.resolve({ canceled: true }),
      requestMediaLibraryPermissionsAsync: () => Promise.resolve({ granted: false })
    }),
    'expo-file-system': () => ({
      File: class {
        readonly size = 0
        delete(): void {}
      },
      Paths: { cache: 'file:///cache' }
    }),
    'lucide-react-native': () => ({ X: 'Icon' }),
    'react-native-safe-area-context': async () => {
      const { createContext } = await import('react')
      return {
        useSafeAreaInsets: () => ({ bottom: 8, left: 0, right: 0, top: 44 }),
        useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
        SafeAreaFrameContext: createContext(null),
        SafeAreaInsetsContext: createContext(null),
        SafeAreaProvider: ({ children }: { children: unknown }) => children
      }
    },
    'expo-router': () => ({
      router: { replace: vi.fn() },
      useRouter: () => ({
        push: dependencies.push,
        back: dependencies.back,
        canGoBack: () => dependencies.canGoBack
      }),
      usePathname: () => dependencies.pathname,
      useNavigation: () => ({
        setOptions: dependencies.setScreenOptions,
        dispatch: dependencies.dispatch,
        isFocused: () => dependencies.screenFocused
      }),
      useNavigationContainerRef: () => ({ getRootState: () => dependencies.rootState }),
      useFocusEffect: (effect: () => undefined | (() => void)) => React.useEffect(effect, [effect])
    }),
    // Use a component to observe keyed remounts; host-string prop updates cannot prove WebView replacement.
    '../../modules/orca-mobile-web-shell/src': () => {
      return {
        OrcaMobileWebShellView: (props: {
          sessionId: string
          ref?: (handle: { postBridgeMessage: (json: string) => Promise<void> } | null) => void
        }) => {
          dependencies.viewRenders += 1
          React.useEffect(() => {
            dependencies.lifecycle.push(`mount:${props.sessionId}`)
            return () => {
              dependencies.lifecycle.push(`unmount:${props.sessionId}`)
            }
          }, [props.sessionId])
          // Attach the real view’s handle so posted frames can reach the simulated page.
          const attach = props.ref
          React.useLayoutEffect(() => {
            attach?.({
              postBridgeMessage: (json: string) => {
                dependencies.posted.push(json)
                return dependencies.postFails
                  ? Promise.reject(new Error('the view would not take it'))
                  : Promise.resolve()
              }
            })
            return () => {
              attach?.(null)
            }
          }, [attach])
          return React.createElement('ShellViewProbe', props)
        },
        parseMobileWebShellLoadState: parseMobileWebShellLoadState
      }
    },
    '../app-update/use-wall-app-update': () => ({ useWallAppUpdate: () => null }),
    // Keep the real bridge hook; stub only Expo-dependent client lookup.
    '../transport/host-client-hooks': () => ({
      useHostClient: () => ({ client: dependencies.client })
    }),
    // Stub host-store input to avoid expo-secure-store’s unavailable global.
    './use-page-host-snapshot': () => ({
      usePageHostSnapshot: () => ({
        // Keep preference identity stable like useState; fresh objects would rebuild the bridge on every render and settle pending requests.
        snapshot: SCREEN_SNAPSHOT,
        unreadable: dependencies.snapshotUnreadable,
        retry: () => {},
        readStorage: () => ({ storage: {}, storageOversize: [] }),
        refreshStorage: () => {
          dependencies.storageRefreshes += 1
        },
        writeStorage: () => {}
      })
    }),
    './use-mobile-web-shell-session': () => ({
      useMobileWebShellSession: () => ({
        state: dependencies.state,
        downloadProgress: dependencies.downloadProgress,
        pageRoutes: dependencies.pageRoutes,
        routeGrants: dependencies.routeGrants,
        updateNotice: dependencies.updateNotice,
        retry: dependencies.retry,
        reportShellFailure: dependencies.reportShellFailure,
        reportDocumentStarted: dependencies.reportDocumentStarted,
        reportDocumentLoaded: dependencies.reportDocumentLoaded,
        reportPageReady: dependencies.reportPageReady,
        reportPagePainted: dependencies.reportPagePainted,
        reportPageBackClaim: dependencies.reportPageBackClaim,
        pageReady: dependencies.pageReady,
        pageFrame: dependencies.pageFrame,
        backClaimed: dependencies.backClaimed,
        ownsHostArea: dependencies.ownsHostArea
      })
    })
  }
}
