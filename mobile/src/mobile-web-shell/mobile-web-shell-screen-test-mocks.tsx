// Module mocks for the hybrid shell screen's tests, shared so a suite split by concern mounts the
// same world. Each test file registers them with `vi.mock(path, mocks[path])`.
import * as React from 'react'
import { vi } from 'vitest'
import { parseMobileWebShellLoadState } from '../../modules/orca-mobile-web-shell/src/load-state'
import { SCREEN_SNAPSHOT, type ScreenDependencies } from './mobile-web-shell-screen-test-harness'

export function screenModuleMocks(dependencies: ScreenDependencies) {
  return {
    'react-native': () => ({
      ActivityIndicator: 'ActivityIndicator',
      Easing: { in: (fn: unknown) => fn, quad: 'quad' },
      // Enough of it for the cover to mount, fade and unmount. What the fade looks like is not this
      // test's business; that the cover is up until the page paints is, and that is the `visible` prop.
      Animated: {
        View: 'Animated.View',
        Value: class {
          setValue(): void {}
        },
        timing: () => ({
          start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
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
        // The real values, so a case that reads them off the cover reads something.
        absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
      },
      Text: 'Text',
      View: 'View'
    }),
    // Reaching the real one imports the Expo runtime this test does not have. The screen only passes
    // the handler through; what it does with a verb is `native-clipboard.test.ts`.
    'expo-clipboard': () => ({
      setStringAsync: () => Promise.resolve(true),
      getStringAsync: () => Promise.resolve('')
    }),
    // Same reason, and the screen only hands `playPageHaptic` over: which expo member each kind
    // reaches is `page-haptics.test.ts`. `Platform.OS` above is pinned to `ios`, so the Android
    // members are never evaluated and are not listed.
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
    'react-native-safe-area-context': () => ({
      useSafeAreaInsets: () => ({ bottom: 8, left: 0, right: 0, top: 44 })
    }),
    'expo-router': () => ({
      router: { replace: vi.fn() },
      useRouter: () => ({
        push: dependencies.push,
        back: dependencies.back,
        canGoBack: () => dependencies.canGoBack
      }),
      // Read by the pop latch, which clears on the route this shell is mounted at changing.
      usePathname: () => dependencies.pathname,
      // The screen's own place on the stack, which is where the iOS swipe-back is taken away.
      useNavigation: () => ({ setOptions: dependencies.setScreenOptions })
    }),
    // A component rather than a host string: the React key is what makes a retry a rebuilt WebView,
    // and a mount/unmount log is the only thing that can tell a remount from a prop update.
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
          // The handle the real view exposes, which nothing here used to attach: without it every
          // post rejected as a view that is gone, so no case could see a frame reach the page.
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
    // The real bridge hook runs, so the props it owns are the ones the view is handed here; only the
    // client lookup is stubbed, because reaching it imports the Expo runtime this test does not have.
    '../transport/client-context': () => ({
      useHostClient: () => ({ client: dependencies.client })
    }),
    // Reaching the real one imports the host store and expo-secure-store, whose module touches an Expo
    // global this test does not have. What it answers is the screen's input, not its behaviour.
    './use-page-host-snapshot': () => ({
      usePageHostSnapshot: () => ({
        // One object for the life of the file, as the real hook's `useState` gives. A fresh literal per
        // render changes the identity the host effect is keyed on, so the bridge host was being torn
        // down and rebuilt on every render of this screen — and every pending request settled with it.
        snapshot: SCREEN_SNAPSHOT,
        unreadable: dependencies.snapshotUnreadable,
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
        pageOwnsSafeArea: dependencies.pageOwnsSafeArea
      })
    })
  }
}
