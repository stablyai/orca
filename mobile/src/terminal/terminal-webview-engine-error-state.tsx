import { useCallback, useState } from 'react'
import { MonitorX, RefreshCw } from 'lucide-react-native'
import { StyleSheet, Text, View } from 'react-native'
import { Button } from '../components/ui/Button'
import { Collapsible } from '../components/ui/Collapsible'
import { colors, spacing, textStyles, typography } from '../theme/mobile-theme'

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
  const [showDetails, setShowDetails] = useState(false)
  return (
    <View style={styles.errorOverlay}>
      <View style={styles.body} accessibilityRole="alert">
        <MonitorX size={32} color={colors.textMuted} strokeWidth={1.75} />
        <Text style={styles.errorTitle}>Terminal failed to load</Text>
        <Text style={styles.errorMessage}>
          Reload to bring it back. The session keeps running on your desktop.
        </Text>
        {/* Stretched, as the centred column would give the clipping frame no width; it cancels the
            column's gap while shut and carries it inside, so the gap eases in with the text. */}
        <View style={styles.detailFrame}>
          <Collapsible open={showDetails}>
            <Text style={[styles.errorDetail, styles.detailGap]} numberOfLines={6} selectable>
              {message}
            </Text>
          </Collapsible>
        </View>
        <View style={styles.actions}>
          <Button
            label="Reload"
            icon={RefreshCw}
            variant="primary"
            size="compact"
            onPress={onReload}
          />
          <Button
            label={showDetails ? 'Hide details' : 'Details'}
            variant="plain"
            size="compact"
            onPress={() => setShowDetails((shown) => !shown)}
          />
        </View>
      </View>
    </View>
  )
}

const BODY_GAP = 10

const styles = StyleSheet.create({
  errorOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl + 16,
    backgroundColor: colors.terminalBg
  },
  body: { maxWidth: 320, alignItems: 'center', gap: BODY_GAP },
  errorTitle: {
    ...textStyles.title,
    fontSize: 20,
    lineHeight: 25,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: 6
  },
  errorMessage: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' },
  detailFrame: { alignSelf: 'stretch', marginTop: -BODY_GAP },
  detailGap: { paddingTop: BODY_GAP },
  errorDetail: {
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    textAlign: 'center'
  },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }
})
