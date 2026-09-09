import React from 'react'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from './automation-page-parts'
import { translate } from '@/i18n/i18n'

type CommitPushActionFieldsProps = {
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}

function readMessage(config: Record<string, unknown>): string {
  const value = config.message
  return typeof value === 'string' ? value : ''
}

// Why: committing without pushing is the unusual case, so the checkbox
// starts checked — only an explicit `false` opts out.
function readPush(config: Record<string, unknown>): boolean {
  return config.push !== false
}

export function CommitPushActionFields({
  config,
  onChange
}: CommitPushActionFieldsProps): React.JSX.Element {
  const message = readMessage(config)
  const push = readPush(config)

  return (
    <div className="space-y-3">
      <Field
        label={translate(
          'auto.components.automations.CommitPushActionFields.a1b2c3d4e5',
          'Commit message'
        )}
      >
        <Input
          value={message}
          onChange={(event) => onChange({ ...config, message: event.target.value })}
          placeholder={translate(
            'auto.components.automations.CommitPushActionFields.f6a7b8c9d0',
            'Automated commit'
          )}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <Checkbox
          checked={push}
          onCheckedChange={(checked) => onChange({ ...config, push: checked === true })}
        />
        {translate(
          'auto.components.automations.CommitPushActionFields.e1f2a3b4c5',
          'Push after commit'
        )}
      </label>
    </div>
  )
}
