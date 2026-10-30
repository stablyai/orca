import { useState } from 'react'
import { PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { copyJiraTextToClipboard } from './jira-issue-workspace-actions'
import {
  getJiraPromptTemplates,
  loadCustomJiraPromptTemplate,
  renderJiraPromptTemplate,
  saveCustomJiraPromptTemplate
} from './jira-prompt-templates'

export function JiraPromptTemplatePopover({
  issue,
  onClose,
  onCloseAutoFocus
}: {
  issue: JiraIssue
  onClose: () => void
  onCloseAutoFocus: (event: Event) => void
}): React.JSX.Element {
  const templates = getJiraPromptTemplates()
  const [selectedId, setSelectedId] = useState('implementation')
  const [customTemplate, setCustomTemplate] = useState(loadCustomJiraPromptTemplate)
  const [otherPrompt, setOtherPrompt] = useState('')
  const [copying, setCopying] = useState(false)
  const template =
    selectedId === 'custom'
      ? customTemplate
      : (templates.find((candidate) => candidate.id === selectedId)?.text ?? templates[0].text)
  const prompt = renderJiraPromptTemplate(template, issue, otherPrompt)
  return (
    <PopoverContent
      align="end"
      className="w-[32rem] max-w-[calc(100vw-2rem)]"
      aria-label={translate('jira.prompt.dialogTitle', 'Copy prompt from template')}
      onClick={(event) => event.stopPropagation()}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div className="max-h-[calc(100vh-4rem)] overflow-y-auto scrollbar-sleek p-4">
        <div className="mb-4 space-y-1">
          <h3 className="text-sm font-medium">
            {translate('jira.prompt.dialogTitle', 'Copy prompt from template')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {issue.key} · {issue.title}
          </p>
        </div>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="jira-prompt-template">
              {translate('jira.prompt.template', 'Template')}
            </Label>
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger id="jira-prompt-template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {templates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">
                  {translate('jira.prompt.custom', 'Custom template')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {selectedId === 'custom' ? (
            <div className="space-y-2">
              <Label htmlFor="jira-custom-template">
                {translate('jira.prompt.templateText', 'Template text')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'jira.prompt.variables',
                  'Use $jira-issue for the issue context and $other-prompt for your additional instructions. Saved on this device.'
                )}
              </p>
              <Textarea
                id="jira-custom-template"
                value={customTemplate}
                onChange={(event) => {
                  setCustomTemplate(event.target.value)
                  saveCustomJiraPromptTemplate(event.target.value)
                }}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="jira-other-prompt">
              {translate('jira.prompt.other', 'Additional instructions (optional)')}
            </Label>
            <Textarea
              id="jira-other-prompt"
              value={otherPrompt}
              onChange={(event) => setOtherPrompt(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="jira-prompt-preview">
              {translate('jira.prompt.preview', 'Preview')}
            </Label>
            <Textarea id="jira-prompt-preview" readOnly value={prompt} className="h-40" />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {translate('common.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={copying || !prompt}
            onClick={async () => {
              setCopying(true)
              const copied = await copyJiraTextToClipboard(prompt, 'prompt')
              setCopying(false)
              if (copied) {
                onClose()
              }
            }}
          >
            {translate('auto.components.JiraIssueWorkspace.0cc62bd690', 'Copy prompt')}
          </Button>
        </div>
      </div>
    </PopoverContent>
  )
}
