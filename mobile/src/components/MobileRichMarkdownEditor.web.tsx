import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef
} from 'react'
import { StyleSheet, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { openExternalLink } from '../platform/external-link'
import { MobileRichMarkdownToolbar } from './MobileRichMarkdownToolbar'
import { TextInputModal } from './TextInputModal'
import {
  mountRichMarkdownWebDocument,
  type RichMarkdownWebDocument
} from './rich-markdown/rich-markdown-web-document-mount'
import { RICH_MARKDOWN_URL_PROMPT_LABELS } from './rich-markdown/document-host-seams'
import { useMobileRichMarkdownEditorController } from './use-mobile-rich-markdown-editor-controller'
import type {
  RichMarkdownEditorApi,
  RichMarkdownUrlPromptKind
} from './rich-markdown/document-host-seams'
import type { MobileRichMarkdownEditorMessage } from './mobile-rich-markdown-editor-contract'
// The native component's own props and handle, so a change to either fails here rather than
// drifting.
import type {
  MobileRichMarkdownEditorComponentProps,
  MobileRichMarkdownEditorHandle
} from './MobileRichMarkdownEditor'

/**
 * Web sibling: the same editor, with the WebView taken out.
 *
 * `react-native-webview` has no web build that renders anything, so what the page does instead is
 * mount the document itself — the modules under `rich-markdown/` are the program the WebView's
 * script is bundled from, called here with the page's own hooks. The toolbar above it is the same
 * row of fifteen the phone renders, and the controller between the two is the same controller, so
 * `MarkdownReader` and the screen around it cannot tell which of the two they have.
 *
 * Two seams are the page's rather than the window's. Messages go to `handleMessage` directly and
 * never through `window.ReactNativeWebView`, which on the page is the *shell's* bridge. The URL the
 * Link and Image commands need comes from `TextInputModal`: `window.prompt` was measured to return
 * null in both shells — neither implements the delegate the dialog needs — so on the phone those
 * two commands silently do nothing, and here they ask.
 *
 * `onKeyboardInsetChange` is accepted and never called, which is correct rather than missing. It
 * exists because native `Keyboard` events under-report a WebView's covered area; on the page the
 * document's `visualViewport` reads and the screen's `keyboard-occlusion.web.ts` are the same
 * measurement of the same viewport with the same formula, so driving the prop would lift the
 * screen's own bar twice. The mount supplies no inset source, so there is nothing to report.
 */
function MobileRichMarkdownEditorWebInner(
  { content, editable, onChange, onOpenLink }: MobileRichMarkdownEditorComponentProps,
  ref: ForwardedRef<MobileRichMarkdownEditorHandle>
) {
  const hostRef = useRef<View>(null)
  const documentRef = useRef<RichMarkdownWebDocument | null>(null)
  // The document reports itself ready from inside the mount call, so the controller answers it —
  // setting the content and the editable flag — while the effect below is still on the line that
  // built the document and `documentRef` is null. Those are the calls this holds, replayed the
  // moment there is a handle. Dropping them would leave the editor empty for good.
  const beforeMountRef = useRef<((send: RichMarkdownEditorApi) => void)[]>([])
  const receiveRef = useRef<((message: MobileRichMarkdownEditorMessage) => void) | null>(null)
  const [urlPromptKind, setUrlPromptKind] = useState<RichMarkdownUrlPromptKind | null>(null)
  // The modal's half of `promptForUrl`: the command is waiting on this, and it is answered once,
  // by a submit, a cancel, or the unmount below.
  const pendingUrlRef = useRef<((url: string | null) => void) | null>(null)
  // What the user typed, held until the drawer has gone. Measured in WebKit: answering while the
  // field still had the focus left `execCommand` acting on a document that did not hold the
  // selection, and Link and Image inserted nothing at all.
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

  // In an effect, not during render: React may replay or discard render work, and the document
  // reads this ref from a callback that outlives the render that mounted it. The mount effect
  // below is declared after this one, so the first read already sees a sink.
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
        // A second ask while one is open cancels the first, so no command is left awaiting a modal
        // that has been replaced.
        pendingUrlRef.current?.(null)
        answeredUrlRef.current = null
        pendingUrlRef.current = resolve
        setUrlPromptKind(kind)
      }),
    []
  )

  useEffect(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: react-native-web renders View as a div and forwards the ref to it; this module only ever runs in that build.
    const host = hostRef.current as unknown as HTMLElement | null
    if (!host) {
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
      // Answered before the document goes, so a command awaiting the modal resumes into a stopped
      // document — which refuses it — rather than holding this mount's scope for good.
      pendingUrlRef.current?.(null)
      pendingUrlRef.current = null
      live.dispose()
    }
    // Mounted once, with `promptForUrl` read from the closure rather than named as a dependency:
    // re-running this would throw away a live document and the caret in it, and every callback
    // prop above changes identity on each render.
  }, [])

  return (
    <View style={styles.container}>
      <MobileRichMarkdownToolbar editable={editable} onCommand={runCommand} />
      <View ref={hostRef} style={styles.host} />
      <TextInputModal
        visible={urlPromptKind !== null}
        title={urlPromptKind === null ? '' : RICH_MARKDOWN_URL_PROMPT_LABELS[urlPromptKind]}
        placeholder="https://"
        submitLabel="Insert"
        keyboardType="url"
        onSubmit={answerUrlPrompt}
        onCancel={() => answerUrlPrompt(null)}
        onAfterClose={releaseUrlPrompt}
      />
    </View>
  )
}

export const MobileRichMarkdownEditor = memo(forwardRef(MobileRichMarkdownEditorWebInner))

// The native component's own frame, so the editor sits where the editor sat.
const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0, backgroundColor: colors.bgBase },
  host: { flex: 1, minHeight: 0, backgroundColor: colors.bgBase }
})
