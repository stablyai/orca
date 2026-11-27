import { useCallback, useState } from 'react'
import { CircleAlert } from 'lucide-react-native'
import { StyleSheet, View } from 'react-native'
import { translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors } from '../../theme/mobile-theme'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export type NativeWebViewEngineEvent = {
  readonly nativeEvent?: object
}

type TerminalWebViewEngineErrorOverlayProps = {
  readonly message: string
  readonly onReload: () => void
}

type NativeWebViewEngineFields = {
  readonly description?: unknown
  readonly code?: unknown
  readonly statusCode?: unknown
  readonly domain?: unknown
  readonly didCrash?: unknown
}

export function useTerminalWebViewEngineErrorState(onEngineError?: (message: string) => void) {
  const [engineError, setEngineError] = useState<string | null>(null)
  const clearEngineError = useCallback(() => setEngineError(null), [])
  const reportEngineError = useCallback(
    (message: string, fatal: boolean) => {
      onEngineError?.(message)
      console.warn('[terminal-webview] engine error', message)
      if (fatal) {
        // Keep the first fatal cause; later watchdog/cascade reports are less specific until clearEngineError resets it.
        setEngineError((previous) => previous ?? message)
      }
    },
    [onEngineError]
  )
  const reportNativeEngineError = useCallback(
    (context: string, event?: NativeWebViewEngineEvent) => {
      reportEngineError(describeNativeWebViewEngineError(context, event), true)
    },
    [reportEngineError]
  )
  return { clearEngineError, engineError, reportEngineError, reportNativeEngineError }
}

export function describeNativeWebViewEngineError(
  context: string,
  event?: NativeWebViewEngineEvent
): string {
  const native = event?.nativeEvent as NativeWebViewEngineFields | undefined
  const parts = [context]
  const description = native?.description
  const statusCode = native?.statusCode
  const code = native?.code
  const domain = native?.domain
  if (typeof description === 'string') {
    parts.push(description)
  }
  if (typeof statusCode === 'number') {
    parts.push(
      translate('terminal.webviewEngineErrorState.status', 'status {{statusCode}}', { statusCode })
    )
  }
  if (typeof code === 'number') {
    parts.push(translate('terminal.webviewEngineErrorState.code', 'code {{code}}', { code }))
  }
  if (typeof domain === 'string') {
    parts.push(domain)
  }
  if (native?.didCrash === true) {
    parts.push(translate('terminal.webviewEngineErrorState.rendererCrashed', 'renderer crashed'))
  }
  return parts.join(' - ')
}

export function TerminalWebViewEngineErrorOverlay({
  message,
  onReload
}: TerminalWebViewEngineErrorOverlayProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // The engine's own words stay one tap away for support, not in the sentence.
  return (
    <View style={styles.errorOverlay}>
      <MobileStateView
        icon={CircleAlert}
        title={t('terminal.webviewEngineErrorState.title', 'Terminal failed to load')}
        message={t(
          'terminal.webviewEngineErrorState.message',
          'The session on your computer is still running.'
        )}
        details={message}
        action={{ label: t('common.retry', 'Retry'), onPress: onReload }}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  errorOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.bgBase
  }
}))
