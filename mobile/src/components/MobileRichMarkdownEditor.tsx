import { memo, useCallback, useEffect, useMemo, useRef, type ComponentType } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import {
  Bold,
  Code2,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Pilcrow,
  Quote,
  Strikethrough
} from 'lucide-react-native'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'
import { colors, radii, spacing } from '../theme/mobile-theme'
import {
  buildMobileRichMarkdownEditorHtml,
  escapeInjectedJavaScriptString
} from './mobile-rich-markdown-editor-html'

const EDITOR_DOCUMENT_ORIGIN = 'https://orca-mobile-editor.invalid'
const EDITOR_DOCUMENT_URL = `${EDITOR_DOCUMENT_ORIGIN}/rich-markdown-editor`

function normalizeExternalEditorUrl(value: string): string | null {
  const url = value.trim()
  if (!url) {
    return null
  }
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index)
    if (code <= 32 || code === 127) {
      return null
    }
  }
  if (/^mailto:/i.test(url)) {
    return url
  }
  if (!/^https?:\/\//i.test(url)) {
    return null
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

type RichMarkdownCommand =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'quote'
  | 'inlineCode'
  | 'codeBlock'
  | 'link'
  | 'image'

type Props = {
  content: string
  editable: boolean
  onChange: (content: string) => void
}

type EditorWebViewMessage =
  | { type: 'ready' }
  | { type: 'change'; markdown: string; generation: number }
  | { type: 'openLink'; url: string }

type ToolbarItem = {
  command: RichMarkdownCommand
  label: string
  icon: ComponentType<{ size?: number; color?: string }>
}

const TOOLBAR_ITEMS: ToolbarItem[] = [
  { command: 'paragraph', label: 'Body', icon: Pilcrow },
  { command: 'heading1', label: 'H1', icon: Heading1 },
  { command: 'heading2', label: 'H2', icon: Heading2 },
  { command: 'heading3', label: 'H3', icon: Heading3 },
  { command: 'bold', label: 'Bold', icon: Bold },
  { command: 'italic', label: 'Italic', icon: Italic },
  { command: 'strike', label: 'Strike', icon: Strikethrough },
  { command: 'bulletList', label: 'Bullet list', icon: List },
  { command: 'orderedList', label: 'Numbered list', icon: ListOrdered },
  { command: 'taskList', label: 'Checklist', icon: ListTodo },
  { command: 'quote', label: 'Quote', icon: Quote },
  { command: 'link', label: 'Link', icon: Link },
  { command: 'image', label: 'Image', icon: ImageIcon },
  { command: 'inlineCode', label: 'Inline code', icon: Code2 },
  { command: 'codeBlock', label: 'Code block', icon: FileCode2 }
]

function MobileRichMarkdownEditorInner({ content, editable, onChange }: Props) {
  const webViewRef = useRef<WebView>(null)
  const readyRef = useRef(false)
  const documentGenerationRef = useRef(0)
  const currentWebViewContentRef = useRef<string | null>(null)
  const html = useMemo(() => buildMobileRichMarkdownEditorHtml(), [])

  const inject = useCallback((script: string) => {
    webViewRef.current?.injectJavaScript(`${script}\ntrue;`)
  }, [])

  const applyContent = useCallback(
    (nextContent: string) => {
      documentGenerationRef.current += 1
      currentWebViewContentRef.current = nextContent
      inject(
        `window.__orcaRichMarkdown && window.__orcaRichMarkdown.setMarkdown(${escapeInjectedJavaScriptString(nextContent)}, ${documentGenerationRef.current});`
      )
    },
    [inject]
  )

  const applyEditable = useCallback(
    (nextEditable: boolean) => {
      inject(
        `window.__orcaRichMarkdown && window.__orcaRichMarkdown.setEditable(${nextEditable ? 'true' : 'false'});`
      )
    },
    [inject]
  )

  useEffect(() => {
    if (!readyRef.current) {
      return
    }
    if (currentWebViewContentRef.current !== content) {
      applyContent(content)
    }
  }, [applyContent, content])

  useEffect(() => {
    if (readyRef.current) {
      applyEditable(editable)
    }
  }, [applyEditable, editable])

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: unknown
      try {
        message = JSON.parse(event.nativeEvent.data)
      } catch {
        return
      }
      if (!message || typeof message !== 'object') {
        return
      }
      const editorMessage = message as Partial<EditorWebViewMessage>
      if ('type' in message && message.type === 'ready') {
        readyRef.current = true
        applyContent(content)
        applyEditable(editable)
        return
      }
      if (
        editorMessage.type === 'change' &&
        typeof editorMessage.markdown === 'string' &&
        editorMessage.generation === documentGenerationRef.current
      ) {
        currentWebViewContentRef.current = editorMessage.markdown
        onChange(editorMessage.markdown)
        return
      }
      if (editorMessage.type === 'openLink' && typeof editorMessage.url === 'string') {
        const url = normalizeExternalEditorUrl(editorMessage.url)
        if (url) {
          void Linking.openURL(url).catch(() => {})
        }
      }
    },
    [applyContent, applyEditable, content, editable, onChange]
  )

  const handleShouldStartLoadWithRequest = useCallback((request: { url?: string }) => {
    const url = request.url ?? ''
    const isEditorDocument =
      url === 'about:blank' ||
      url === EDITOR_DOCUMENT_URL ||
      url.startsWith(`${EDITOR_DOCUMENT_URL}#`)
    // Why: editor content is untrusted markdown; links must leave through openLink.
    return isEditorDocument
  }, [])

  const runCommand = useCallback(
    (command: RichMarkdownCommand) => {
      inject(
        `window.__orcaRichMarkdown && window.__orcaRichMarkdown.runCommand(${escapeInjectedJavaScriptString(command)});`
      )
    },
    [inject]
  )

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.toolbarContent}
          keyboardShouldPersistTaps="handled"
        >
          {TOOLBAR_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <Pressable
                key={item.command}
                disabled={!editable}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                onPress={() => runCommand(item.command)}
                style={({ pressed }) => [
                  styles.toolbarButton,
                  pressed && editable ? styles.toolbarButtonPressed : null,
                  !editable ? styles.toolbarButtonDisabled : null
                ]}
              >
                <Icon size={15} color={editable ? colors.textPrimary : colors.textMuted} />
              </Pressable>
            )
          })}
        </ScrollView>
      </View>
      <WebView
        ref={webViewRef}
        source={{ html, baseUrl: EDITOR_DOCUMENT_URL }}
        originWhitelist={[EDITOR_DOCUMENT_ORIGIN, 'about:blank']}
        javaScriptEnabled
        domStorageEnabled={false}
        hideKeyboardAccessoryView
        keyboardDisplayRequiresUserAction={false}
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
        style={styles.webView}
        scrollEnabled
        bounces={false}
        nestedScrollEnabled
        setSupportMultipleWindows={false}
        automaticallyAdjustContentInsets={false}
      />
    </View>
  )
}

export const MobileRichMarkdownEditor = memo(MobileRichMarkdownEditorInner)

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.bgBase
  },
  toolbar: {
    minHeight: 42,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  toolbarContent: {
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6
  },
  toolbarButton: {
    minWidth: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    paddingHorizontal: spacing.xs
  },
  toolbarButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  toolbarButtonDisabled: {
    opacity: 0.55
  },
  webView: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.bgBase
  }
})
