import React, { useId, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { AlertTriangle } from 'lucide-react'
import { Field } from './automation-page-parts'
import {
  parseAgentDefaultEnvDraft,
  stringifyAgentDefaultEnvDraft
} from '../settings/agent-default-env-draft'
import { translate } from '@/i18n/i18n'

type RunScriptActionFieldsProps = {
  config: Record<string, unknown>
  onChange: (config: Record<string, unknown>) => void
}

function readScript(config: Record<string, unknown>): string {
  const value = config.script
  return typeof value === 'string' ? value : ''
}

function readEnv(config: Record<string, unknown>): Record<string, string> {
  const value = config.env
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const env: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      env[key] = entry
    }
  }
  return env
}

// EnvEditor — reuses agent-default-env-draft.ts's `KEY=value KEY2=value2`
// single-line parser (already shipped for AgentsPane's per-agent env
// override field), per this task's "tái dùng key-value editor đã có
// trong Settings nếu tồn tại" instruction — not a new pattern.
function EnvEditor({
  env,
  onChange
}: {
  env: Record<string, string>
  onChange: (env: Record<string, string>) => void
}): React.JSX.Element {
  const seed = stringifyAgentDefaultEnvDraft(env)
  const [draft, setDraft] = useState(seed)

  const commit = (): void => {
    onChange(parseAgentDefaultEnvDraft(draft).env)
  }

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit()
          event.currentTarget.blur()
        }
        if (event.key === 'Escape') {
          setDraft(seed)
          event.currentTarget.blur()
        }
      }}
      placeholder={translate(
        'auto.components.automations.RunScriptActionFields.b8f2c1a4d7',
        'KEY=value KEY2=value2'
      )}
      spellCheck={false}
      className="h-8 font-mono text-xs"
    />
  )
}

export function RunScriptActionFields({
  config,
  onChange
}: RunScriptActionFieldsProps): React.JSX.Element {
  const script = readScript(config)
  const env = readEnv(config)
  const warningId = useId()

  return (
    <div className="space-y-3">
      <Field
        label={translate('auto.components.automations.RunScriptActionFields.a1b2c3d4e5', 'Script')}
      >
        <Textarea
          value={script}
          onChange={(event) => onChange({ ...config, script: event.target.value })}
          placeholder={translate(
            'auto.components.automations.RunScriptActionFields.c2d3e4f5a6',
            '#!/bin/sh\necho hello'
          )}
          spellCheck={false}
          aria-describedby={warningId}
          className="min-h-[6rem] font-mono text-xs"
        />
      </Field>
      <Field
        label={translate(
          'auto.components.automations.RunScriptActionFields.d3e4f5a6b7',
          'Environment'
        )}
      >
        <EnvEditor env={env} onChange={(nextEnv) => onChange({ ...config, env: nextEnv })} />
      </Field>
      <p id={warningId} className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        {translate(
          'auto.components.automations.RunScriptActionFields.e4f5a6b7c8',
          'This script runs arbitrary shell commands whenever the automation runs — review it carefully.'
        )}
      </p>
    </div>
  )
}
