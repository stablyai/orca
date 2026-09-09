import React from 'react'
import type { AutomationAction } from '../../../../shared/automations-types'
import type { Repo, Worktree } from '../../../../shared/types'
import { CommitPushActionFields } from './CommitPushActionFields'
import { CreatePrActionFields } from './CreatePrActionFields'
import { RunScriptActionFields } from './RunScriptActionFields'
import { SendNotificationActionFields } from './SendNotificationActionFields'
import { translate } from '@/i18n/i18n'

type AutomationActionConfigFormProps = {
  action: AutomationAction
  onChange: (next: AutomationAction) => void
  repoId: string
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
}

/**
 * Switches on `action.type` to render the field set for that action's
 * `config`. Shared by FE-TASK-AUTO-003 (commit_push/create_pr) and
 * FE-TASK-AUTO-004 (run_script/send_notification).
 * create_worktree/run_agent reuse AutomationEditorDialog's existing
 * project/session fields instead of a config-form case (solution doc §2).
 */
export function AutomationActionConfigForm({
  action,
  onChange,
  repoId,
  repoMap,
  worktrees
}: AutomationActionConfigFormProps): React.JSX.Element {
  const updateConfig = (config: Record<string, unknown>): void => {
    onChange({ ...action, config })
  }

  switch (action.type) {
    case 'commit_push':
      return <CommitPushActionFields config={action.config} onChange={updateConfig} />
    case 'create_pr':
      return (
        <CreatePrActionFields
          config={action.config}
          onChange={updateConfig}
          repoId={repoId}
          repoMap={repoMap}
          worktrees={worktrees}
        />
      )
    case 'run_script':
      return <RunScriptActionFields config={action.config} onChange={updateConfig} />
    case 'send_notification':
      return <SendNotificationActionFields config={action.config} onChange={updateConfig} />
    case 'create_worktree':
    case 'run_agent':
      return (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.AutomationActionConfigForm.a9b0c1d2e3',
            'Configuration for this action type is not available yet.'
          )}
        </p>
      )
  }
}
