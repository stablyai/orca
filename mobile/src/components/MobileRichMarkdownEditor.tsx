import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  type ComponentType,
  type ForwardedRef
} from 'react'
import { Keyboard, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native'
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
import type {
  MobileRichMarkdownCommand,
  MobileRichMarkdownEditorMessage,
  MobileRichMarkdownEditorProps
} from './mobile-rich-markdown-editor-contract'
import { useMobileRichMarkdownEditorController } from './use-mobile-rich-markdown-editor-controller'
import {
  buildMobileRichMarkdownEditorHtml,
  escapeInjectedJavaScriptString
} from './mobile-rich-markdown-editor-html'

const EDITOR_DOCUMENT_ORIGIN = 'https://orca-mobile-editor.invalid'
const EDITOR_DOCUMENT_URL = `${EDITOR_DOCUMENT_ORIGIN}/rich-markdown-editor`

type Props = Omit<MobileRichMarkdownEditorProps, 'onOpenLink'> & {
  onOpenLink?: (url: string) => void
}

export type MobileRichMarkdownEditorHandle = {
  dismissKeyboard: () => void
}

type ToolbarItem = {
  command: MobileRichMarkdownCommand
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

function MobileRichMarkdownEditorInner(
  { content, editable, onChange, onKeyboardInsetChange, onOpenLink }: Props,
  ref: ForwardedRef<MobileRichMarkdownEditorHandle>
) {
  const webViewRef = useRef<WebView>(null)
  const html = useMemo(() => buildMobileRichMarkdownEditorHtml(), [])

  const inject = useCallback((script: string) => {
    webViewRef.current?.injectJavaScript(`${script}\ntrue;`)
  }, [])

  const transport = useMemo(
    () => ({
      setMarkdown: (markdown: string, generation: number) =>
        inject(
          `window.__orcaRichMarkdown && window.__orcaRichMarkdown.setMarkdown(${escapeInjectedJavaScriptString(markdown)}, ${generation});`
        ),
      setEditable: (nextEditable: boolean) =>
        inject(
          `window.__orcaRichMarkdown && window.__orcaRichMarkdown.setEditable(${nextEditable ? 'true' : 'false'});`
        ),
      runCommand: (command: MobileRichMarkdownCommand) =>
        inject(
          `window.__orcaRichMarkdown && window.__orcaRichMarkdown.runCommand(${escapeInjectedJavaScriptString(command)});`
        )
    }),
    [inject]
  )

  const openLink = useCallback(
    (url: string) => {
      if (onOpenLink) {
        onOpenLink(url)
        return
      }
      void Linking.openURL(url).catch(() => {})
    },
    [onOpenLink]
  )

  const { handleMessage, runCommand } = useMobileRichMarkdownEditorController({
    content,
    editable,
    onChange,
    onKeyboardInsetChange,
    onOpenLink: openLink,
    transport
  })

  const handleWebViewMessage = useCallback(
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
      handleMessage(message as Partial<MobileRichMarkdownEditorMessage>)
    },
    [handleMessage]
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

  const dismissKeyboard = useCallback(() => {
    // Why: the caret lives in the WebView, so the injected blur is what closes the keyboard;
    // Keyboard.dismiss only clears a native TextInput that stole focus first.
    inject('window.__orcaRichMarkdown && window.__orcaRichMarkdown.dismissKeyboard();')
    Keyboard.dismiss()
  }, [inject])

  useImperativeHandle(ref, () => ({ dismissKeyboard }), [dismissKeyboard])

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
        onMessage={handleWebViewMessage}
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

export const MobileRichMarkdownEditor = memo(forwardRef(MobileRichMarkdownEditorInner))

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
