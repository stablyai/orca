import { useEffect, useRef, useState } from 'react'
import { StyleSheet, TextInput, View, useWindowDimensions } from 'react-native'
import {
  MOBILE_COMPOSER_IMAGE_PASTE_EVENT,
  createMobileComposerPasteImageDelivery,
  spliceMobileComposerPasteText,
  type MobileComposerPastedImage
} from './mobile-native-chat-composer-image-paste'
import {
  claimMobileComposerImagePaste,
  readMobileComposerImageFile
} from './mobile-native-chat-composer-image-paste-claim.web'
import { useKeyboardOcclusion } from '../../../platform/keyboard-occlusion'
import { useTextInputContentHeight } from '../../../platform/text-input-content-height'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  composerInputStyles,
  MESSAGE_MIN_HEIGHT
} from '../../../components/composer-input/composer-input-styles'
import type { MobileNativeChatComposerFieldProps } from './mobile-native-chat-composer-field-skill'
import { MobileNativeChatComposerFieldCopy } from './MobileNativeChatComposerFieldCopy'

// Share of the space above the keyboard the field may grow into before it scrolls.
const MAX_HEIGHT_SHARE = 0.35

// Textareas cannot style tokens: hide their text under a styled copy while preserving the caret. RN types omit caretColor.
function clearText() {
  return { field: { color: 'transparent', caretColor: colors.textPrimary } }
}

function scrollTopOf(event: unknown): number {
  const target =
    typeof event === 'object' && event !== null && 'currentTarget' in event
      ? event.currentTarget
      : null
  return typeof target === 'object' &&
    target !== null &&
    'scrollTop' in target &&
    typeof target.scrollTop === 'number'
    ? target.scrollTop
    : 0
}

function composerTextarea(node: TextInput | null): HTMLTextAreaElement | null {
  return node instanceof HTMLTextAreaElement ? node : null
}

export function MobileNativeChatComposerField({
  value,
  skillToken,
  dictationPreview,
  placeholder,
  ref,
  onPasteImages,
  onChangeText,
  readClipboardImage,
  ...props
}: MobileNativeChatComposerFieldProps) {
  useMobileColorScheme()
  const [scrollTop, setScrollTop] = useState(0)
  const [fieldHeight, setFieldHeight] = useState(0)
  const ownRef = useRef<TextInput>(null)
  const input = ref ?? ownRef
  const onPasteImagesRef = useRef(onPasteImages)
  onPasteImagesRef.current = onPasteImages
  const onChangeTextRef = useRef(onChangeText)
  onChangeTextRef.current = onChangeText
  const readClipboardImageRef = useRef(readClipboardImage)
  readClipboardImageRef.current = readClipboardImage
  const valueRef = useRef(value)
  valueRef.current = value
  const pasteDeliveryRef = useRef(createMobileComposerPasteImageDelivery())
  useEffect(() => {
    const node = composerTextarea(input.current)
    if (!node) {
      return
    }
    const insertPrompt = (prompt: string, start: number, end: number): void => {
      if (prompt.length === 0) {
        return
      }
      const next = spliceMobileComposerPasteText(valueRef.current, prompt, { start, end })
      onChangeTextRef.current?.(next.text)
      queueMicrotask(() => node.setSelectionRange(next.caret, next.caret))
    }
    const deliverPasted = (incoming: Promise<readonly MobileComposerPastedImage[]>): void => {
      if (!onPasteImagesRef.current) {
        return
      }
      void pasteDeliveryRef.current.take(incoming).then(
        (images) => {
          if (images.length > 0) {
            void onPasteImagesRef.current?.(images)
          }
        },
        (error: unknown) => {
          void onPasteImagesRef.current?.(
            Promise.reject(error instanceof Error ? error : new Error(String(error)))
          )
        }
      )
    }
    const attachNativeImage = (): void => {
      const read = readClipboardImageRef.current
      if (!onPasteImagesRef.current || !read) {
        return
      }
      deliverPasted(read().then((image) => (image ? [image] : [])))
    }
    const onPaste = (event: ClipboardEvent): void => {
      if (event.target !== node || event.defaultPrevented || !onPasteImagesRef.current) {
        return
      }
      const claimed = claimMobileComposerImagePaste(event.clipboardData)
      if (!claimed) {
        return
      }
      event.preventDefault()
      if (claimed.kind === 'files') {
        insertPrompt(
          claimed.promptText,
          node.selectionStart ?? valueRef.current.length,
          node.selectionEnd ?? node.selectionStart ?? valueRef.current.length
        )
        deliverPasted(Promise.all(claimed.files.map((file) => readMobileComposerImageFile(file))))
        return
      }
      // iOS WKWebView omits image items from a textarea paste, so an empty paste asks the pasteboard.
      attachNativeImage()
    }
    const onNativePaste = (event: Event): void => {
      if (document.activeElement !== node) {
        return
      }
      event.preventDefault()
      attachNativeImage()
    }
    document.addEventListener('paste', onPaste, true)
    document.addEventListener(MOBILE_COMPOSER_IMAGE_PASTE_EVENT, onNativePaste)
    return () => {
      document.removeEventListener('paste', onPaste, true)
      document.removeEventListener(MOBILE_COMPOSER_IMAGE_PASTE_EVENT, onNativePaste)
    }
  }, [input])
  const shown = dictationPreview
    ? `${dictationPreview.before}${dictationPreview.text}${dictationPreview.after}`
    : value || placeholder || ''
  const contentHeight = useTextInputContentHeight(input, shown)
  // Reserve the placeholder's lines so the first keystroke cannot shrink the box and drop the transcript.
  const placeholderHeight = useTextInputContentHeight(input, placeholder ?? '')
  const windowHeight = useWindowDimensions().height
  const keyboardHeight = useKeyboardOcclusion()
  // RN Web already shrinks browser dimensions; shell WebViews report the keyboard separately.
  const visibleHeight = Math.min(windowHeight, window.innerHeight - keyboardHeight)
  const sizing = {
    height: Math.max(contentHeight ?? 0, placeholderHeight ?? 0) || undefined,
    maxHeight: Math.max(MESSAGE_MIN_HEIGHT, Math.round(visibleHeight * MAX_HEIGHT_SHARE))
  }
  const copied = Boolean(skillToken || dictationPreview)
  // Keep one tree so adding/removing a skill or dictation cannot remount the field and drop focus.
  return (
    <View
      style={styles.frame}
      onLayout={(event) => setFieldHeight(event.nativeEvent.layout.height)}
    >
      {copied ? (
        <MobileNativeChatComposerFieldCopy
          value={value}
          skillToken={skillToken}
          dictationPreview={dictationPreview}
          fieldHeight={fieldHeight}
          scrollTop={scrollTop}
        />
      ) : null}
      <TextInput
        ref={input}
        value={value}
        onChangeText={onChangeText}
        style={[composerInputStyles.messageText, sizing, copied ? clearText().field : null]}
        onScroll={skillToken ? (event) => setScrollTop(scrollTopOf(event)) : undefined}
        placeholder={dictationPreview ? undefined : placeholder}
        {...props}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    overflow: 'hidden'
  }
})
