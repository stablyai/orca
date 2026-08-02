import { useCallback, useState } from 'react'
import { RefreshCw } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'

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
      // eslint-disable-next-line no-console
      console.warn('[terminal-webview] engine error', message)
      if (fatal) {
        // Why: the first fatal report is the root cause; later cascades (e.g. the
        // web-ready watchdog firing after a process-crash report) must not
        // overwrite its more specific diagnostics. clearEngineError resets.
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
    parts.push(`status ${statusCode}`)
  }
  if (typeof code === 'number') {
    parts.push(`code ${code}`)
  }
  if (typeof domain === 'string') {
    parts.push(domain)
  }
  if (native?.didCrash === true) {
    parts.push('renderer crashed')
  }
  return parts.join(' - ')
}

export function TerminalWebViewEngineErrorOverlay({
  message,
  onReload
}: TerminalWebViewEngineErrorOverlayProps) {
  return (
    <View style={styles.errorOverlay}>
      <Text style={styles.errorTitle}>Terminal failed to load</Text>
      <Text style={styles.errorDetail} numberOfLines={4}>
        {message}
      </Text>
      <Pressable accessibilityRole="button" style={styles.reloadButton} onPress={onReload}>
        <RefreshCw size={16} color={colors.terminalBg} />
        <Text style={styles.reloadButtonText}>Reload</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: colors.terminalBg
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
    borderRadius: 6,
    backgroundColor: colors.surfaceBright
  },
  reloadButtonText: {
    color: colors.terminalBg,
    fontSize: 14,
    fontWeight: '700'
  }
})
