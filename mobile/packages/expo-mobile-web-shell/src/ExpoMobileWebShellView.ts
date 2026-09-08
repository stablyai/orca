import { requireNativeViewManager } from 'expo-modules-core'
import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type RefAttributes
} from 'react'
import { Platform, type NativeSyntheticEvent, type ViewProps } from 'react-native'
import ExpoMobileWebShellModule from './ExpoMobileWebShellModule'

type MobileWebShellEvent<T> = (event: NativeSyntheticEvent<T>) => void

export type MobileWebShellViewRef = {
  activateSessionView(sessionId: string): Promise<void>
  deactivateSessionView(): Promise<void>
  postMessage(message: string): Promise<void>
}

export type MobileWebShellViewProps = ViewProps & {
  sessionId?: string | null
  onBridgeMessage?: MobileWebShellEvent<{ data: string }>
  onNavigationBlocked?: MobileWebShellEvent<{ url: string }>
  onProcessTerminated?: MobileWebShellEvent<{ sessionId: string }>
  onLoadState?: MobileWebShellEvent<{ state: 'loading' | 'loaded' | 'failed'; reason?: string }>
}

const NativeMobileWebShellView: ComponentType<
  MobileWebShellViewProps & RefAttributes<MobileWebShellViewRef>
> = requireNativeViewManager('ExpoMobileWebShell')

const ExpoMobileWebShellView = forwardRef<MobileWebShellViewRef, MobileWebShellViewProps>(
  function ExpoMobileWebShellView(props, forwardedRef) {
    const nativeRef = useRef<MobileWebShellViewRef>(null)
    const lastSessionIdRef = useRef<string | null>(null)
    useEffect(() => {
      if (props.sessionId) {
        lastSessionIdRef.current = props.sessionId
      }
    }, [props.sessionId])

    useImperativeHandle(
      forwardedRef,
      () => ({
        activateSessionView: async (sessionId) => {
          lastSessionIdRef.current = sessionId
          if (Platform.OS === 'android') {
            await ExpoMobileWebShellModule.activateViewSession(sessionId)
            return
          }
          await requireNativeView(nativeRef).activateSessionView(sessionId)
        },
        deactivateSessionView: async () => {
          const sessionId = lastSessionIdRef.current
          if (Platform.OS === 'android' && sessionId) {
            await ExpoMobileWebShellModule.deactivateViewSession(sessionId)
            return
          }
          await requireNativeView(nativeRef).deactivateSessionView()
        },
        postMessage: async (message) => {
          const sessionId = lastSessionIdRef.current
          if (Platform.OS === 'android' && sessionId) {
            await ExpoMobileWebShellModule.postViewMessage(sessionId, message)
            return
          }
          await requireNativeView(nativeRef).postMessage(message)
        }
      }),
      []
    )

    return createElement(NativeMobileWebShellView, { ...props, ref: nativeRef })
  }
)

function requireNativeView(ref: { current: MobileWebShellViewRef | null }) {
  if (!ref.current) {
    throw new Error('mobile_web_shell_view_unavailable')
  }
  return ref.current
}

export default ExpoMobileWebShellView
