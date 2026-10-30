import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef
} from 'react'
import { View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { openExternalLink } from '../platform/external-link'
import { MobileRichMarkdownToolbar } from './MobileRichMarkdownToolbar'
import { TextInputModal } from './TextInputModal'
import {
  ensureDocumentStyle,
  mountRichMarkdownWebDocument,
  type RichMarkdownWebDocument
} from './rich-markdown/rich-markdown-web-document-mount'
import { useMobileRichMarkdownEditorController } from './use-mobile-rich-markdown-editor-controller'
import type {
  RichMarkdownEditorApi,
  RichMarkdownUrlPromptKind
} from './rich-markdown/document-host-seams'
import type {
  MobileRichMarkdownEditorMessage,
  MobileRichMarkdownEditorProps
} from './mobile-rich-markdown-editor-contract'

export type MobileRichMarkdownEditorComponentProps = Omit<
  MobileRichMarkdownEditorProps,
  'onOpenLink'
> & {
  onOpenLink?: (url: string) => void
}

export type MobileRichMarkdownEditorHandle = {
  dismissKeyboard: () => void
}

// Mount rich-markdown document directly with shared controller/toolbar; call handleMessage, never shell’s window.ReactNativeWebView bridge.
// Link/Image ask TextInputModal because both native shells’ window.prompt returns null (no dialog delegate).
// Accept but never call onKeyboardInsetChange: page visualViewport and keyboard-occlusion already measure same cover, so callback would double-lift toolbar.
function MobileRichMarkdownEditorWebInner(
  { content, editable, onChange, onOpenLink }: MobileRichMarkdownEditorComponentProps,
  ref: ForwardedRef<MobileRichMarkdownEditorHandle>
) {
  const t = useMobileTranslation()
  const colorScheme = useMobileColorScheme()
  const hostRef = useRef<View>(null)
  const documentRef = useRef<RichMarkdownWebDocument | null>(null)
  // Document reports ready synchronously during mount before documentRef exists; queue controller content/editable calls until handle arrives or editor stays empty.
  const beforeMountRef = useRef<((send: RichMarkdownEditorApi) => void)[]>([])
  const receiveRef = useRef<((message: MobileRichMarkdownEditorMessage) => void) | null>(null)
  const [urlPromptKind, setUrlPromptKind] = useState<RichMarkdownUrlPromptKind | null>(null)
  // Settle promptForUrl once via submit/cancel/unmount so no command stays pending.
  const pendingUrlRef = useRef<((url: string | null) => void) | null>(null)
  // Hold typed URL until drawer loses focus; WebKit execCommand otherwise lacks document selection and inserts nothing.
  const answeredUrlRef = useRef<string | null>(null)

  const send = useCallback((call: (api: RichMarkdownEditorApi) => void) => {
    const mounted = documentRef.current
    if (mounted) {
      call(mounted.send)
      return
    }
    beforeMountRef.current.push(call)
  }, [])

  const transport = useMemo(
    () => ({
      setMarkdown: (markdown: string, generation: number) =>
        send((api) => {
          api.setMarkdown(markdown, generation)
        }),
      setEditable: (nextEditable: boolean) =>
        send((api) => {
          api.setEditable(nextEditable)
        }),
      runCommand: (command: Parameters<RichMarkdownEditorApi['runCommand']>[0]) =>
        send((api) => {
          void api.runCommand(command)
        })
    }),
    [send]
  )

  const openLink = useCallback(
    (url: string) => {
      if (onOpenLink) {
        onOpenLink(url)
        return
      }
      openExternalLink(url)
    },
    [onOpenLink]
  )

  const { handleMessage, runCommand } = useMobileRichMarkdownEditorController({
    content,
    editable,
    onChange,
    onOpenLink: openLink,
    transport
  })

  useImperativeHandle(
    ref,
    () => ({
      dismissKeyboard: () => {
        send((api) => {
          api.dismissKeyboard()
        })
      }
    }),
    [send]
  )

  // Update sink in effect before mount effect: callback outlives renders, which React may replay/discard.
  useEffect(() => {
    receiveRef.current = handleMessage
  }, [handleMessage])

  /** Closes the modal, keeping the answer for the moment the field no longer has the focus. */
  const answerUrlPrompt = useCallback((url: string | null) => {
    answeredUrlRef.current = url
    setUrlPromptKind(null)
  }, [])

  /** The drawer has gone: the document may have its caret back, and its command may run. */
  const releaseUrlPrompt = useCallback(() => {
    const pending = pendingUrlRef.current
    const url = answeredUrlRef.current
    pendingUrlRef.current = null
    answeredUrlRef.current = null
    pending?.(url)
  }, [])

  const promptForUrl = useCallback(
    (kind: RichMarkdownUrlPromptKind) =>
      new Promise<string | null>((resolve) => {
        // New prompt cancels prior pending command instead of stranding it on replaced modal.
        pendingUrlRef.current?.(null)
        answeredUrlRef.current = null
        pendingUrlRef.current = resolve
        setUrlPromptKind(kind)
      }),
    []
  )

  useEffect(() => {
    // react-native-web renders View as a div and forwards the ref to it.
    const host = hostRef.current
    if (!(host instanceof HTMLElement)) {
      return
    }
    const live = mountRichMarkdownWebDocument(host, {
      postToHost: (message) => receiveRef.current?.(message),
      promptForUrl
    })
    documentRef.current = live
    for (const call of beforeMountRef.current) {
      call(live.send)
    }
    beforeMountRef.current = []
    return () => {
      documentRef.current = null
      // Settle modal before disposing document so command resumes into stopped/refusing document rather than retaining mount scope.
      pendingUrlRef.current?.(null)
      pendingUrlRef.current = null
      live.dispose()
    }
    // Mount document once; read promptForUrl via closure because rerunning on changing callback props discards live caret/document.
  }, [])

  // Layout effect: restore the host's scope class before paint after a themed className swap.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (documentRef.current && host instanceof HTMLElement) {
      ensureDocumentStyle(host)
    }
  }, [colorScheme])

  return (
    <View style={styles.container}>
      <MobileRichMarkdownToolbar editable={editable} onCommand={runCommand} />
      <View ref={hostRef} style={styles.host} />
      <TextInputModal
        visible={urlPromptKind !== null}
        title={
          urlPromptKind === null
            ? ''
            : urlPromptKind === 'link'
              ? t('components.richMarkdownEditor.linkUrl', 'Link URL')
              : t('components.richMarkdownEditor.imageUrl', 'Image URL')
        }
        placeholder="https://"
        submitLabel={t('components.richMarkdownEditor.insert', 'Insert')}
        keyboardType="url"
        onSubmit={answerUrlPrompt}
        onCancel={() => answerUrlPrompt(null)}
        onAfterClose={releaseUrlPrompt}
      />
    </View>
  )
}

export const MobileRichMarkdownEditor = memo(forwardRef(MobileRichMarkdownEditorWebInner))

const styles = themedStyleSheet(() => ({
  container: { flex: 1, minHeight: 0, backgroundColor: colors.bgBase },
  host: { flex: 1, minHeight: 0, backgroundColor: colors.bgBase }
}))
