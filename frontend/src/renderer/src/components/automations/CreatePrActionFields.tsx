import React from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from './automation-page-parts'
import { CreateFromPicker } from './CreateFromPicker'
import type { Repo, Worktree } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

type CreatePrActionFieldsProps = {
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
  repoId: string
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
}

function readString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

// Why: draft defaults true — CR-AUTO-003 recommends starting PRs as drafts
// to reduce spam risk from unattended automation runs.
function readDraft(config: Record<string, unknown>): boolean {
  return config.draft !== false
}

export function CreatePrActionFields({
  config,
  onChange,
  repoId,
  repoMap,
  worktrees
}: CreatePrActionFieldsProps): React.JSX.Element {
  const title = readString(config, 'title')
  const body = readString(config, 'body')
  const base = readString(config, 'base')
  const draft = readDraft(config)

  return (
    <div className="space-y-3">
      <Field
        label={translate('auto.components.automations.CreatePrActionFields.a2b3c4d5e6', 'Title')}
      >
        <Input
          value={title}
          onChange={(event) => onChange({ ...config, title: event.target.value })}
          placeholder={translate(
            'auto.components.automations.CreatePrActionFields.b3c4d5e6f7',
            'Pull request title'
          )}
        />
      </Field>
      <Field
        label={translate(
          'auto.components.automations.CreatePrActionFields.c4d5e6f7a8',
          'Description'
        )}
      >
        <Textarea
          value={body}
          onChange={(event) => onChange({ ...config, body: event.target.value })}
          placeholder={translate(
            'auto.components.automations.CreatePrActionFields.d5e6f7a8b9',
            'Description (optional)'
          )}
          className="min-h-[6rem]"
        />
      </Field>
      <Field
        label={translate(
          'auto.components.automations.CreatePrActionFields.e6f7a8b9c0',
          'Base branch'
        )}
      >
        <CreateFromPicker
          repoId={repoId}
          repoMap={repoMap}
          worktrees={worktrees}
          value={base}
          onValueChange={(nextBase) => onChange({ ...config, base: nextBase })}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Checkbox
          checked={draft}
          onCheckedChange={(checked) => onChange({ ...config, draft: checked === true })}
        />
        {translate(
          'auto.components.automations.CreatePrActionFields.f7a8b9c0d1',
          'Create as draft PR'
        )}
      </label>
    </div>
  )
}
