import React, { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import { LoaderCircle } from 'lucide-react'

import { createRichMarkdownExtensions } from '@/components/editor/rich-markdown-extensions'
import { encodeRawMarkdownHtmlForRichEditor } from '@/components/editor/raw-markdown-html'
import { LinearIssueMarkdownToolbar } from '@/components/LinearIssueMarkdownToolbar'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type LinearIssueMarkdownDescriptionEditorProps = {
  value: string
  onChange: (value: string) => void
  onSave: (value: string) => void
  density: 'page' | 'drawer'
  disabled: boolean
  submitShortcutLabel: string
}

function createLinearIssueMarkdownExtensions() {
  const extensions = createRichMarkdownExtensions()
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
  onChange,
  onSave,
  density,
  disabled,
  submitShortcutLabel
}: LinearIssueMarkdownDescriptionEditorProps): React.JSX.Element {
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const lastEditorMarkdownRef = useRef(value)
  const editorRef = useRef<Editor | null>(null)
  const linearIssueMarkdownExtensions = useMemo(() => {
    // Why: Tiptap freezes extension options when the editor is created; the
    // language value is the recreation key for translated extension options.
    void language
    return createLinearIssueMarkdownExtensions()
  }, [language])

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: linearIssueMarkdownExtensions,
      content: encodeRawMarkdownHtmlForRichEditor(value),
      contentType: 'markdown',
      editable: !disabled,
      editorProps: {
        attributes: {
          class: 'rich-markdown-editor',
          spellcheck: 'true',
          'aria-label': 'Issue description'
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
    [language]
  )

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

    // Why: Linear remains the source of truth when the selected issue changes
    // or an optimistic save is reverted; keep the rich view aligned with it.
    editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(value), {
      contentType: 'markdown',
      emitUpdate: false
    })
    lastEditorMarkdownRef.current = value
  }, [editor, value])

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
      <div className="linear-issue-markdown-scroll scrollbar-sleek">
        <EditorContent editor={editor} />
      </div>
      <div className="linear-issue-markdown-save-hint pointer-events-none absolute bottom-1.5 right-2 z-10 flex items-center gap-1.5 text-[10px] text-muted-foreground/75">
        <span className="flex items-center gap-1">
          <span>{submitShortcutLabel}</span>
          <span>
            {translate('auto.components.LinearIssueMarkdownDescriptionEditor.a7301a11f3', 'save')}
          </span>
        </span>
        <span className="text-muted-foreground/35">·</span>
        <span>
          {translate('auto.components.LinearIssueMarkdownDescriptionEditor.d9c47069ef', 'Markdown')}
        </span>
      </div>
      {disabled ? (
        <LoaderCircle className="absolute right-2 top-2 size-4 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  )
}
