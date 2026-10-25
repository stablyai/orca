import { useRef, useState, type ReactNode } from 'react'
import { Clipboard, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { copyJiraTextToClipboard } from './jira-issue-workspace-actions'
import { buildJiraIssuePrompt } from './jira-prompt-templates'
import { Popover, PopoverAnchor } from '@/components/ui/popover'
import { JiraPromptTemplatePopover } from './JiraPromptTemplatePopover'

export function JiraIssueRowCopyMenu({
  issue,
  children
}: {
  issue: JiraIssue
  children?: ReactNode
}): React.JSX.Element {
  const [templateOpen, setTemplateOpen] = useState(false)
  const anchorRef = useRef<HTMLElement | null>(null)
  const setAnchor = (element: HTMLDivElement | null) => {
    anchorRef.current = element
  }
  const actions = [
    {
      label: translate('auto.components.JiraIssueWorkspace.38839801e8', 'Copy key'),
      text: issue.key,
      copiedLabel: 'Key'
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.779bb91ee0', 'Copy URL'),
      text: issue.url,
      copiedLabel: 'URL'
    },
    {
      label: translate('auto.components.JiraIssueWorkspace.0cc62bd690', 'Copy prompt'),
      text: buildJiraIssuePrompt(issue),
      copiedLabel: 'Prompt'
    }
  ]
  const Item = children ? ContextMenuItem : DropdownMenuItem
  const Separator = children ? ContextMenuSeparator : DropdownMenuSeparator
  const items = (
    <>
      {actions.map((action) => (
        <Item
          key={action.copiedLabel}
          onSelect={() => void copyJiraTextToClipboard(action.text, action.copiedLabel)}
        >
          <Clipboard className="size-3.5" />
          {action.label}
        </Item>
      ))}
      <Separator />
      <Item onSelect={() => setTemplateOpen(true)}>
        <FileText className="size-3.5" />
        {translate('jira.prompt.dialogTitle', 'Copy prompt from template')}
      </Item>
    </>
  )
  return (
    <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
      {children ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <PopoverAnchor asChild ref={setAnchor}>
              {children}
            </PopoverAnchor>
          </ContextMenuTrigger>
          <ContextMenuContent
            onClick={(event) => event.stopPropagation()}
            onCloseAutoFocus={(event) => {
              if (templateOpen) {
                event.preventDefault()
              }
            }}
          >
            {items}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <PopoverAnchor asChild ref={setAnchor}>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate('jira.copy.context', 'Copy context for {{key}}', {
                      key: issue.key
                    })}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Clipboard className="size-3.5" />
                  </Button>
                </PopoverAnchor>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{translate('jira.copy.actions', 'Copy issue context')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="end"
            onClick={(event) => event.stopPropagation()}
            onCloseAutoFocus={(event) => {
              if (templateOpen) {
                event.preventDefault()
              }
            }}
          >
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {templateOpen ? (
        <JiraPromptTemplatePopover
          issue={issue}
          onClose={() => setTemplateOpen(false)}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            anchorRef.current?.focus()
          }}
        />
      ) : null}
    </Popover>
  )
}
