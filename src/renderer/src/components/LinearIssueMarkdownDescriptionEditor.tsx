import React, { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import { LoaderCircle } from 'lucide-react'

import { createRichMarkdownExtensions } from '@/components/editor/rich-markdown/schema/rich-markdown-extensions'
import { setRichMarkdownImageResolverContext } from '@/components/editor/rich-markdown/images/rich-markdown-image-context'
import { encodeRawMarkdownHtmlForRichEditor } from '@/components/editor/rich-markdown/raw-source/raw-markdown-html'
import {
  createRichMarkdownEditorCodec,
  type RichMarkdownEditorCodec
} from '@/components/editor/rich-markdown/document/rich-markdown-source-transport'
import { LinearIssueMarkdownToolbar } from '@/components/LinearIssueMarkdownToolbar'
import { RichMarkdownTableControls } from '@/components/editor/rich-markdown/tables/RichMarkdownTableControls'
import { isScreenSubmitShortcut } from '@/lib/keyboard/screen-submit-shortcut'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  getRichMarkdownSpellcheckAttribute,
  useRichMarkdownSpellcheckAttribute
} from '@/components/editor/rich-markdown/instance/rich-markdown-spellcheck'
import { recomputeOn } from '@/lib/recompute-on'

type LinearIssueMarkdownDescriptionEditorProps = {
  value: string
  imageUrls?: Record<string, string>
  onChange: (value: string) => void
  onSave: (value: string) => void
  density: 'page' | 'drawer'
  disabled: boolean
  submitShortcutLabel: string
}

function createLinearIssueMarkdownExtensions(codec: RichMarkdownEditorCodec) {
  const extensions = createRichMarkdownExtensions({ codec })
  return [
    ...extensions,
    Placeholder.configure({
      placeholder: translate(
        'auto.components.LinearIssueMarkdownDescriptionEditor.4f2fddc2b7',
        'No description provided.'
      )
    })
  ]
}

export function LinearIssueMarkdownDescriptionEditor({
  value,
  imageUrls,
  onChange,
  onSave,
  density,
  disabled,
  submitShortcutLabel
}: LinearIssueMarkdownDescriptionEditorProps): React.JSX.Element {
  const t = useTranslate()
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const lastEditorMarkdownRef = useRef(value)
  const editorScrollRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Editor | null>(null)
  const richMarkdownSpellcheckEnabled = useAppStore(
    (s) => s.settings?.richMarkdownSpellcheckEnabled ?? true
  )
  // Recreate the private Marked registry with Tiptap on language changes to avoid accumulating tokenizers.
  const codec = useMemo(
    () => recomputeOn([language], () => createRichMarkdownEditorCodec()),
    [language]
  )
  // Language keys editor recreation because Tiptap freezes translated extension options.
  const linearIssueMarkdownExtensions = useMemo(
    () => recomputeOn([language], () => createLinearIssueMarkdownExtensions(codec)),
    [codec, language]
  )

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: linearIssueMarkdownExtensions,
      content: encodeRawMarkdownHtmlForRichEditor(value, codec),
      contentType: 'markdown',
      editable: !disabled,
      editorProps: {
        attributes: {
          class: 'rich-markdown-editor',
          spellcheck: getRichMarkdownSpellcheckAttribute(richMarkdownSpellcheckEnabled),
          'aria-label': t(
            'auto.components.LinearIssueWorkspace.issueDescriptionLabel',
            'Issue description'
          )
        },
        handleKeyDown: (_view, event) => {
          if (!isScreenSubmitShortcut(event)) {
            return false
          }
          event.preventDefault()
          editorRef.current?.commands.blur()
          return true
        }
      },
      onFocus: () => {
        window.api.ui.setMarkdownEditorFocused(true)
      },
      onBlur: ({ editor: nextEditor }) => {
        window.api.ui.setMarkdownEditorFocused(false)
        const nextValue = nextEditor.getMarkdown()
        lastEditorMarkdownRef.current = nextValue
        onChange(nextValue)
        onSave(nextValue)
      },
      onUpdate: ({ editor: nextEditor }) => {
        const nextValue = nextEditor.getMarkdown()
        lastEditorMarkdownRef.current = nextValue
        onChange(nextValue)
      }
    },
    [codec, language]
  )
  useRichMarkdownSpellcheckAttribute(editor, richMarkdownSpellcheckEnabled)

  useEffect(() => {
    if (editor) {
      setRichMarkdownImageResolverContext(editor, { filePath: '', imageUrls })
    }
  }, [editor, imageUrls])

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [disabled, editor])

  useEffect(() => {
    if (!editor || value === lastEditorMarkdownRef.current) {
      return
    }

    const currentMarkdown = editor.getMarkdown()
    if (currentMarkdown === value) {
      lastEditorMarkdownRef.current = value
      return
    }

    // Follow Linear’s value on issue changes and optimistic rollback.
    editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(value, codec), {
      contentType: 'markdown',
      emitUpdate: false
    })
    lastEditorMarkdownRef.current = value
  }, [codec, editor, value])

  return (
    <div
      className={cn(
        'linear-issue-markdown-editor',
        density === 'page'
          ? 'linear-issue-markdown-editor-page'
          : 'linear-issue-markdown-editor-drawer',
        disabled && 'is-disabled'
      )}
    >
      <LinearIssueMarkdownToolbar editor={editor} disabled={disabled} />
      <div ref={editorScrollRef} className="linear-issue-markdown-scroll relative scrollbar-sleek">
        <EditorContent editor={editor} />
        <RichMarkdownTableControls
          disabled={disabled}
          editor={editor}
          scrollContainerRef={editorScrollRef}
        />
      </div>
      <div className="linear-issue-markdown-save-hint pointer-events-none absolute bottom-1.5 right-2 z-10 flex items-center gap-1.5 text-[10px] text-muted-foreground/75">
        <span className="flex items-center gap-1">
          <span>{submitShortcutLabel}</span>
          <span>
            {t('auto.components.LinearIssueMarkdownDescriptionEditor.a7301a11f3', 'save')}
          </span>
        </span>
        <span className="text-muted-foreground/35">·</span>
        <span>
          {t('auto.components.LinearIssueMarkdownDescriptionEditor.d9c47069ef', 'Markdown')}
        </span>
      </div>
      {disabled ? (
        <LoaderCircle className="absolute right-2 top-2 size-4 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  )
}
