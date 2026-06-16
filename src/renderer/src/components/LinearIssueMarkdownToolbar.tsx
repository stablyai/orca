import React, { useCallback } from 'react'
import type { Editor } from '@tiptap/react'
import { useTranslation } from 'react-i18next'
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
  Pilcrow,
  Quote,
  Strikethrough
} from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type LinearIssueMarkdownToolbarButtonProps = {
  active?: boolean
  disabled?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}

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
  const href = window.prompt(
    translate('auto.components.LinearIssueMarkdownDescriptionEditor.5c16ec8f14', 'Link URL'),
    previousHref ?? ''
  )
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

export function LinearIssueMarkdownToolbar({
  editor,
  disabled
}: {
  editor: Editor | null
  disabled: boolean
}): React.JSX.Element {
  // Why: this toolbar can outlive editor recreation, so subscribe directly to language changes.
  useTranslation()
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
    <div
      className="linear-issue-markdown-toolbar"
      aria-label={translate(
        'auto.components.LinearIssueMarkdownDescriptionEditor.7c52151156',
        'Issue description formatting'
      )}
    >
      <LinearIssueMarkdownToolbarButton
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.68a41d5665',
          'Body text'
        )}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().setParagraph().run())}
      >
        <Pilcrow className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.e3f741d258',
          'Heading 1'
        )}
        active={editor?.isActive('heading', { level: 1 }) ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleHeading({ level: 1 }).run())
        }
      >
        <Heading1 className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.dddaa7a0a6',
          'Heading 2'
        )}
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
        label={translate('auto.components.LinearIssueMarkdownDescriptionEditor.caa88f50d0', 'Bold')}
        active={editor?.isActive('bold') ?? false}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleBold().run())}
      >
        <Bold className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.5666b4493d',
          'Italic'
        )}
        active={editor?.isActive('italic') ?? false}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleItalic().run())}
      >
        <Italic className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.28fd951b83',
          'Strike'
        )}
        active={editor?.isActive('strike') ?? false}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleStrike().run())}
      >
        <Strikethrough className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.ad1869bd54',
          'Inline code'
        )}
        active={editor?.isActive('code') ?? false}
        disabled={disabled}
        onClick={() => runCommand((nextEditor) => nextEditor.chain().focus().toggleCode().run())}
      >
        <Code className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarSeparator />
      <LinearIssueMarkdownToolbarButton
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.c82917e06e',
          'Bullet list'
        )}
        active={editor?.isActive('bulletList') ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleBulletList().run())
        }
      >
        <List className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.d6b2f3d35b',
          'Numbered list'
        )}
        active={editor?.isActive('orderedList') ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleOrderedList().run())
        }
      >
        <ListOrdered className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.e2a0267c8c',
          'Checklist'
        )}
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
        label={translate(
          'auto.components.LinearIssueMarkdownDescriptionEditor.9eaf02ac01',
          'Quote'
        )}
        active={editor?.isActive('blockquote') ?? false}
        disabled={disabled}
        onClick={() =>
          runCommand((nextEditor) => nextEditor.chain().focus().toggleBlockquote().run())
        }
      >
        <Quote className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
      <LinearIssueMarkdownToolbarButton
        label={
          editor?.isActive('link')
            ? translate(
                'auto.components.LinearIssueMarkdownDescriptionEditor.340160f4e8',
                'Remove link'
              )
            : translate('auto.components.LinearIssueMarkdownDescriptionEditor.632096eb1c', 'Link')
        }
        active={editor?.isActive('link') ?? false}
        disabled={disabled}
        onClick={() => runCommand(applyLinearIssueLink)}
      >
        <LinkIcon className="size-3.5" />
      </LinearIssueMarkdownToolbarButton>
    </div>
  )
}
