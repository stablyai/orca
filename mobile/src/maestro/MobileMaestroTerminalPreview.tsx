import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { subscribeMobileTerminalSafely } from '../session/mobile-terminal-stream-subscribe'
import { TerminalWebView } from '../terminal/TerminalWebView'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { resolveMobileMaestroTerminalHandle } from './mobile-maestro-terminal-resolution'

type PreviewState = 'connecting' | 'live' | 'unavailable'

const MAESTRO_TERMINAL_TEXT_SCALE = 0.8

type MobileMaestroTerminalPreviewProps = {
  client: RpcClient | null
  terminalTabId: string
  paneKey: string
  worktreeId: string | null
  sessionId: string | null
  active: boolean
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback
}

function initialTerminalContent(event: Record<string, unknown>): string {
  if (typeof event.serialized === 'string') {
    return event.serialized
  }
  if (Array.isArray(event.lines)) {
    return event.lines.filter((line): line is string => typeof line === 'string').join('\r\n')
  }
  return ''
}

export function MobileMaestroTerminalPreview({
  client,
  terminalTabId,
  paneKey,
  worktreeId,
  sessionId,
  active
}: MobileMaestroTerminalPreviewProps) {
  if (!active) {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.placeholderTitle}>Terminal</Text>
        <Text style={styles.placeholderText}>Tap to bring this surface forward</Text>
      </View>
    )
  }
  if (!sessionId) {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.placeholderTitle}>Terminal reconnecting</Text>
        <Text style={styles.placeholderText}>The exact tab is still available.</Text>
      </View>
    )
  }
  return (
    <ActiveMobileMaestroTerminalPreview
      key={`${terminalTabId}\0${paneKey}\0${worktreeId ?? ''}\0${sessionId}`}
      client={client}
      terminalTabId={terminalTabId}
      paneKey={paneKey}
      worktreeId={worktreeId}
      sessionId={sessionId}
    />
  )
}

function ActiveMobileMaestroTerminalPreview({
  client,
  terminalTabId,
  paneKey,
  worktreeId,
  sessionId
}: {
  client: RpcClient | null
  terminalTabId: string
  paneKey: string
  worktreeId: string | null
  sessionId: string
}) {
  const terminalRef = useRef<TerminalWebViewHandle | null>(null)
  const [webReady, setWebReady] = useState(false)
  const [previewState, setPreviewState] = useState<PreviewState>('connecting')
  const [terminalHandle, setTerminalHandle] = useState<string | null>(null)

  useEffect(() => {
    if (!client) {
      return
    }
    let current = true
    void resolveMobileMaestroTerminalHandle({
      client,
      terminalTabId,
      paneKey,
      worktreeId,
      sessionId
    })
      .then((handle) => {
        if (!current) {
          return
        }
        if (!handle) {
          setPreviewState('unavailable')
          return
        }
        setTerminalHandle(handle)
      })
      .catch(() => current && setPreviewState('unavailable'))
    return () => {
      current = false
    }
  }, [client, paneKey, sessionId, terminalTabId, worktreeId])

  useEffect(() => {
    if (!client || !terminalHandle || !webReady) {
      return
    }
    let initialized = false
    return subscribeMobileTerminalSafely(
      client,
      { terminal: terminalHandle },
      (result) => {
        const event = result as Record<string, unknown>
        if (event.type === 'end' || event.type === 'error') {
          setPreviewState('unavailable')
          return
        }
        if (event.type === 'scrollback') {
          const cols = positiveInteger(event.cols, 80)
          const rows = positiveInteger(event.rows, 24)
          terminalRef.current?.init(cols, rows, initialTerminalContent(event))
          initialized = true
          setPreviewState('live')
          return
        }
        if (event.type === 'data' && typeof event.chunk === 'string') {
          if (!initialized) {
            terminalRef.current?.init(80, 24, event.chunk)
            initialized = true
          } else {
            terminalRef.current?.write(event.chunk)
          }
          setPreviewState('live')
          return
        }
        if (event.type === 'resized') {
          const cols = positiveInteger(event.cols, 80)
          const rows = positiveInteger(event.rows, 24)
          if (typeof event.serialized === 'string') {
            terminalRef.current?.init(cols, rows, event.serialized, true)
            initialized = true
          } else {
            terminalRef.current?.resize(cols, rows)
          }
          setPreviewState('live')
        }
      },
      () => setPreviewState('unavailable')
    )
  }, [client, terminalHandle, webReady])

  return (
    <View pointerEvents="none" style={styles.preview}>
      <TerminalWebView
        ref={terminalRef}
        style={styles.webView}
        textScale={MAESTRO_TERMINAL_TEXT_SCALE}
        onWebReady={() => setWebReady(true)}
        onEngineError={() => setPreviewState('unavailable')}
      />
      {previewState !== 'live' ? (
        <View style={styles.loadingOverlay}>
          {previewState === 'connecting' ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : null}
          <Text style={styles.loadingText}>
            {previewState === 'connecting'
              ? 'Attaching live terminal…'
              : 'Live preview unavailable'}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  preview: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: colors.terminalBg
  },
  webView: { flex: 1 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.terminalBg
  },
  loadingText: { color: colors.textMuted, fontSize: typography.metaSize },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    padding: spacing.md,
    backgroundColor: colors.terminalBg
  },
  placeholderTitle: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  placeholderText: { color: colors.textMuted, fontSize: 10, textAlign: 'center' }
})
