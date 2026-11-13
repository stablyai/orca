import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import {
  buildNativeChatVisualDocument,
  clampNativeChatVisualHeight,
  nativeChatVisualPingMessage,
  nativeChatVisualThemeMessage,
  NATIVE_CHAT_VISUAL_PONG_TIMEOUT_MS,
  readNativeChatVisualFrameMessage,
  readNativeChatVisualPong
} from '../../../../../src/shared/native-chat/native-chat-visual-shell'
import type { MobileNativeChatVisualHostMode } from './mobile-native-chat-visual-host-document'
import { MOBILE_NATIVE_CHAT_VISUAL_THEME } from './mobile-native-chat-visual-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { colors } from '../../../theme/mobile-theme'
import { useNativeVerbs } from '../../../mobile-web-shell/bridge/use-native-verbs'
import { useWorkspaceExecutionHost } from '../../../navigation/workspace-execution-host'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import {
  MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT,
  MOBILE_NATIVE_CHAT_VISUAL_LINK_WINDOW_MS
} from './mobile-native-chat-visual-host-document'
import { parseExecutionHostId } from '../../../../../src/shared/execution-host'
import { openExternalLink } from '../../../platform/external-link'

export type MobileNativeChatVisualFrameProps = {
  html: string
  title: string
  mode: MobileNativeChatVisualHostMode
  onFailed: () => void
  source: MobileNativeChatVisualSource
  file: string
}

// Sealed frames run no script to report height; use an internally scrolling fixed-height frame.
const SEALED_INLINE_HEIGHT = 320

export const MobileNativeChatVisualFrame = memo(function MobileNativeChatVisualFrame({
  html,
  title,
  mode,
  source,
  file,
  onFailed
}: MobileNativeChatVisualFrameProps) {
  const native = useNativeVerbs()
  return native.canOpenVisualDocument ? (
    <InteractiveVisualFrame {...{ html, title, mode, source, file, onFailed }} native={native} />
  ) : (
    <SealedVisualFrame {...{ html, title, mode }} />
  )
})

function isVisualDocumentUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const parent = new URL(location.href)
    return (
      url.protocol === parent.protocol &&
      url.host.toLowerCase() === parent.host.toLowerCase() &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/_orca_visual\/[0-9a-f-]{36}\.html$/.test(url.pathname)
    )
  } catch {
    return false
  }
}

function InteractiveVisualFrame({
  html,
  title,
  mode,
  source,
  file,
  onFailed,
  native
}: MobileNativeChatVisualFrameProps & { native: ReturnType<typeof useNativeVerbs> }) {
  const colorScheme = useMobileColorScheme()
  const executionHost = useWorkspaceExecutionHost()
  const frame = useRef<HTMLIFrameElement>(null)
  const [document, setDocument] = useState<{ url: string; channel: string } | null>(null)
  const [height, setHeight] = useState(MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT)
  const ping = useRef(0)
  const lastLinkAt = useRef(-Infinity)
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const open = native.openVisualDocument
  const release = native.releaseVisualDocument
  useEffect(() => {
    let abandoned = false
    let opened: string | null = null
    setDocument(null)
    const owner = parseExecutionHostId(executionHost)
    void open({
      sessionId: source.sessionId,
      file,
      ...(owner?.kind === 'runtime' ? { executionHost: owner.id } : {})
    })
      .then(async (value) => {
        opened = value.url
        if (abandoned || !isVisualDocumentUrl(value.url)) {
          await release(value.url).catch(() => {})
          if (!abandoned) {
            onFailed()
          }
        } else {
          setDocument(value)
        }
      })
      .catch(() => {
        if (!abandoned) {
          onFailed()
        }
      })
    return () => {
      abandoned = true
      if (opened) {
        void release(opened).catch(() => {})
      }
      if (timeout.current) {
        clearTimeout(timeout.current)
      }
    }
  }, [html, source.client, source.sessionId, file, executionHost, open, release, onFailed])

  useEffect(() => {
    if (!document) {
      return
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) {
        return
      }
      if (readNativeChatVisualPong(event.data, document.channel) === ping.current) {
        if (timeout.current) {
          clearTimeout(timeout.current)
        }
      }
      const message = readNativeChatVisualFrameMessage(event.data, document.channel)
      if (mode === 'inline' && message?.kind === 'size') {
        setHeight(clampNativeChatVisualHeight(message.height))
      }
      if (
        message?.kind === 'open-link' &&
        window.document.activeElement === frame.current &&
        navigator.userActivation?.isActive &&
        Date.now() - lastLinkAt.current >= MOBILE_NATIVE_CHAT_VISUAL_LINK_WINDOW_MS
      ) {
        lastLinkAt.current = Date.now()
        openExternalLink(message.url)
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [document, mode])

  const publishTheme = () => {
    if (document) {
      frame.current?.contentWindow?.postMessage(
        nativeChatVisualThemeMessage(MOBILE_NATIVE_CHAT_VISUAL_THEME, document.channel),
        '*'
      )
    }
  }
  useEffect(publishTheme, [colorScheme, document])
  return (
    <View style={mode === 'inline' ? { width: '100%', height } : styles.fullscreen}>
      {document ? (
        <iframe
          ref={frame}
          title={title}
          sandbox="allow-scripts"
          src={document.url}
          referrerPolicy="no-referrer"
          style={IFRAME_STYLE}
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'"
          onError={onFailed}
          onLoad={() => {
            publishTheme()
            if (timeout.current) {
              clearTimeout(timeout.current)
            }
            ping.current += 1
            frame.current?.contentWindow?.postMessage(
              nativeChatVisualPingMessage(ping.current, document.channel),
              '*'
            )
            timeout.current = setTimeout(onFailed, NATIVE_CHAT_VISUAL_PONG_TIMEOUT_MS)
          }}
        />
      ) : (
        <ActivityIndicator color={colors.textMuted} size="small" />
      )}
    </View>
  )
}

// Older native shells keep the script-free preview until the binary supports isolated documents.
function SealedVisualFrame({
  html,
  title,
  mode
}: Pick<MobileNativeChatVisualFrameProps, 'html' | 'title' | 'mode'>) {
  const colorScheme = useMobileColorScheme()
  const document = useMemo(
    () =>
      buildNativeChatVisualDocument({
        html,
        channel: 'sealed',
        theme: MOBILE_NATIVE_CHAT_VISUAL_THEME
      }),
    // Sealed frames run no script, so a scheme rebuild loses no state.
    [html, colorScheme]
  )
  return (
    <View style={mode === 'inline' ? styles.inline : styles.fullscreen}>
      <iframe
        title={title}
        sandbox=""
        srcDoc={document}
        referrerPolicy="no-referrer"
        style={IFRAME_STYLE}
      />
    </View>
  )
}

// Use DOM styles because this is an iframe, not a React Native view.
const IFRAME_STYLE = {
  border: 'none',
  width: '100%',
  height: '100%',
  backgroundColor: 'transparent'
} as const

const styles = StyleSheet.create({
  inline: { width: '100%', height: SEALED_INLINE_HEIGHT },
  fullscreen: { flex: 1 }
})
