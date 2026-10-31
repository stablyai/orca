import { useCallback, useState } from 'react'
import { RefreshCw } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

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
  return (
    <View style={styles.errorOverlay}>
      <Text style={styles.errorTitle}>
        {t('terminal.webviewEngineErrorState.title', 'Terminal failed to load')}
      </Text>
      <Text style={styles.errorDetail} numberOfLines={4}>
        {message}
      </Text>
      <Pressable accessibilityRole="button" style={styles.reloadButton} onPress={onReload}>
        <RefreshCw size={16} color={colors.bgBase} />
        <Text style={styles.reloadButtonText}>
          {t('terminal.webviewEngineErrorState.reload', 'Reload')}
        </Text>
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: colors.bgBase
  },
  errorTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center'
  },
  errorDetail: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center'
  },
  reloadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: radii.control,
    backgroundColor: colors.surfaceBright
  },
  reloadButtonText: {
    color: colors.bgBase,
    fontSize: 14,
    fontWeight: '700'
  }
}))
