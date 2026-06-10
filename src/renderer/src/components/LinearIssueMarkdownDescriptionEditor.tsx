import React, { useCallback, useEffect, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  ListTodo,
  LoaderCircle,
  Pilcrow,
  Quote,
  Strikethrough
} from 'lucide-react'

import { createRichMarkdownExtensions } from '@/components/editor/rich-markdown-extensions'
import { encodeRawMarkdownHtmlForRichEditor } from '@/components/editor/raw-markdown-html'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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

type LinearIssueMarkdownToolbarButtonProps = {
  active?: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}

const linearIssueMarkdownExtensions = [
  ...createRichMarkdownExtensions(),
  Placeholder.configure({
    placeholder: translate("auto.components.LinearIssueMarkdownDescriptionEditor.4f2fddc2b7", "No description provided.")
  })
]

function LinearIssueMarkdownToolbarButton({
  active = false,
  disabled = false,
  label,
  onClick,
  children
}: LinearIssueMarkdownToolbarButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className={cn('linear-issue-markdown-toolbar-button', active && 'is-active')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function LinearIssueMarkdownToolbarSeparator(): React.JSX.Element {
  return <div className="linear-issue-markdown-toolbar-separator" />
}

function applyLinearIssueLink(editor: Editor | null): void {
  if (!editor) {
    return
  }
  if (editor.isActive('link')) {
    editor.chain().focus().unsetLink().run()
    return
  }

  const previousHref = editor.getAttributes('link').href as string | undefined
  const href = window.prompt(translate("auto.components.LinearIssueMarkdownDescriptionEditor.5c16ec8f14", "Link URL"), previousHref ?? '')
  if (href === null) {
    editor.chain().focus().run()
    return
  }

  const trimmed = href.trim()
  if (!trimmed) {
    editor.chain().focus().unsetLink().run()
    return
  }

  editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run()
}

function LinearIssueMarkdownToolbar({
  editor,
  disabled
}: {
  editor: Editor | null
  disabled: boolean
}): React.JSX.Element {
  const runCommand = useCallback(
    (command: (editor: Editor) => void) => {
      if (!editor || disabled) {
        return
      }
      command(editor)
    },
    [disabled, editor]
  )

  return (
    <div className="linear-issue-markdown-toolbar" aria-label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.7c52151156", "Issue description formatting")}>
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.68a41d5665", "Body text")}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().setParagraph().run())}
      >
        <Pilcrow className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.e3f741d258", "Heading 1")}
        active={editor?.isActive('heading', { level: 1 }) ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleHeading({ level: 1 }).run())
        }
      >
        <Heading1 className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.dddaa7a0a6", "Heading 2")}
        active={editor?.isActive('heading', { level: 2 }) ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleHeading({ level: 2 }).run())
        }
      >
        <Heading2 className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarSeparator />
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.caa88f50d0", "Bold")}
        active={editor?.isActive('bold') ?? false}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleBold().run())}
      >
        <Bold className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.5666b4493d", "Italic")}
        active={editor?.isActive('italic') ?? false}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleItalic().run())}
      >
        <Italic className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.28fd951b83", "Strike")}
        active={editor?.isActive('strike') ?? false}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleStrike().run())}
      >
        <Strikethrough className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.ad1869bd54", "Inline code")}
        active={editor?.isActive('code') ?? false}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleCode().run())}
      >
        <Code className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarSeparator />
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.c82917e06e", "Bullet list")}
        active={editor?.isActive('bulletList') ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleBulletList().run())
        }
      >
        <List className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.d6b2f3d35b", "Numbered list")}
        active={editor?.isActive('orderedList') ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleOrderedList().run())
        }
      >
        <ListOrdered className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.e2a0267c8c", "Checklist")}
        active={editor?.isActive('taskList') ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleTaskList().run())
        }
      >
        <ListTodo className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarSeparator />
      <LinearIssueMarkdownToolbarButton
        label={translate("auto.components.LinearIssueMarkdownDescriptionEditor.9eaf02ac01", "Quote")}
        active={editor?.isActive('blockquote') ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleBlockquote().run())
        }
      >
        <Quote className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={editor?.isActive('link') ? translate("auto.components.LinearIssueMarkdownDescriptionEditor.340160f4e8", "Remove link") : translate("auto.components.LinearIssueMarkdownDescriptionEditor.632096eb1c", "Link")}
        active={editor?.isActive('link') ?? false}
        disabled={disabled}
        onClick={() => runCommand(applyLinearIssueLink)}
      >
        <LinkIcon className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
    </div>
  )
}

export function LinearIssueMarkdownDescriptionEditor({
  value,
  onChange,
  onSave,
  density,
  disabled,
  submitShortcutLabel
}: LinearIssueMarkdownDescriptionEditorProps): React.JSX.Element {
  const lastEditorMarkdownRef = useRef(value)
  const editorRef = useRef<Editor | null>(null)

  const editor = useEditor({
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
  })

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
          <span>{translate("auto.components.LinearIssueMarkdownDescriptionEditor.a7301a11f3", "save")}</span>
        </span>
        <span className="text-muted-foreground/35">·</span>
        <span>{translate("auto.components.LinearIssueMarkdownDescriptionEditor.d9c47069ef", "Markdown")}</span>
      </div>
      {disabled ? (
        <LoaderCircle className="absolute right-2 top-2 size-4 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  )
}
