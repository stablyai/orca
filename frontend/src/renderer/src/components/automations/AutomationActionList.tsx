import React from 'react'
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import type { AutomationAction, AutomationActionType } from '../../../../shared/automations-types'
import type { Repo, Worktree } from '../../../../shared/types'
import { AutomationActionConfigForm } from './AutomationActionConfigForm'

// Why: v1 ships up/down reorder buttons, not drag-and-drop — see
// FE-AUTO-SOL-003 §2 ("mũi tên lên/xuống cho v1").
const ACTION_TYPE_ORDER: AutomationActionType[] = [
  'create_worktree',
  'run_agent',
  'commit_push',
  'create_pr',
  'send_notification',
  'run_script'
]

// Why: a function (not a module-scope object) so labels re-evaluate through
// translate() on every render and stay reactive to a live UI-language switch.
function getActionTypeLabel(type: AutomationActionType): string {
  switch (type) {
    case 'create_worktree':
      return translate(
        'auto.components.automations.AutomationActionList.a1a1a1a1a1',
        'Create worktree'
      )
    case 'run_agent':
      return translate('auto.components.automations.AutomationActionList.b2b2b2b2b2', 'Run agent')
    case 'commit_push':
      return translate(
        'auto.components.automations.AutomationActionList.c3c3c3c3c3',
        'Commit & push'
      )
    case 'create_pr':
      return translate('auto.components.automations.AutomationActionList.d4d4d4d4d4', 'Create PR')
    case 'send_notification':
      return translate(
        'auto.components.automations.AutomationActionList.e5e5e5e5e5',
        'Send notification'
      )
    case 'run_script':
      return translate('auto.components.automations.AutomationActionList.f6f6f6f6f6', 'Run script')
  }
}

function createAction(type: AutomationActionType): AutomationAction {
  return { id: createBrowserUuid(), type, config: {}, continueOnFailure: false }
}

function moveAction(actions: AutomationAction[], id: string, delta: -1 | 1): AutomationAction[] {
  const index = actions.findIndex((action) => action.id === id)
  const targetIndex = index + delta
  if (index === -1 || targetIndex < 0 || targetIndex >= actions.length) {
    return actions
  }
  const next = actions.slice()
  const [moved] = next.splice(index, 1)
  next.splice(targetIndex, 0, moved)
  return next
}

type AutomationActionListProps = {
  repoId: string
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
  /** Why: uncontrolled by design — FE-TASK-AUTO-003's file-list constraint
   *  forbids adding action-related state to AutomationEditorDialog.tsx, so
   *  this list owns its own actions[] and only reports out via
   *  onActionsChange for whichever future task wires it to automation save. */
  initialActions?: AutomationAction[]
  onActionsChange?: (actions: AutomationAction[]) => void
}

export function AutomationActionList({
  repoId,
  repoMap,
  worktrees,
  initialActions,
  onActionsChange
}: AutomationActionListProps): React.JSX.Element {
  const [actions, setActions] = React.useState<AutomationAction[]>(initialActions ?? [])

  const updateActions = React.useCallback(
    (updater: (current: AutomationAction[]) => AutomationAction[]): void => {
      setActions((current) => {
        const next = updater(current)
        onActionsChange?.(next)
        return next
      })
    },
    [onActionsChange]
  )

  const handleAdd = (type: AutomationActionType): void => {
    updateActions((current) => [...current, createAction(type)])
  }

  const handleRemove = (id: string): void => {
    updateActions((current) => current.filter((action) => action.id !== id))
  }

  const handleMove = (id: string, delta: -1 | 1): void => {
    updateActions((current) => moveAction(current, id, delta))
  }

  const handleActionChange = (id: string, next: AutomationAction): void => {
    updateActions((current) => current.map((action) => (action.id === id ? next : action)))
  }

  const handleContinueOnFailureChange = (id: string, continueOnFailure: boolean): void => {
    updateActions((current) =>
      current.map((action) => (action.id === id ? { ...action, continueOnFailure } : action))
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {translate('auto.components.automations.AutomationActionList.11223344aa', 'Actions')}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Plus className="size-3.5" />
              {translate(
                'auto.components.automations.AutomationActionList.22334455bb',
                'Add action'
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ACTION_TYPE_ORDER.map((type) => (
              <DropdownMenuItem key={type} onSelect={() => handleAdd(type)}>
                {getActionTypeLabel(type)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {actions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.AutomationActionList.33445566cc',
            'No actions yet — add one to build a chain.'
          )}
        </p>
      ) : null}

      {actions.map((action, index) => (
        <div key={action.id} className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">
              {index + 1}. {getActionTypeLabel(action.type)}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.automations.AutomationActionList.44556677dd',
                  'Move action up'
                )}
                disabled={index === 0}
                onClick={() => handleMove(action.id, -1)}
              >
                <ChevronUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.automations.AutomationActionList.55667788ee',
                  'Move action down'
                )}
                disabled={index === actions.length - 1}
                onClick={() => handleMove(action.id, 1)}
              >
                <ChevronDown className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.automations.AutomationActionList.66778899ff',
                  'Remove action'
                )}
                onClick={() => handleRemove(action.id)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </div>

          <AutomationActionConfigForm
            action={action}
            onChange={(next) => handleActionChange(action.id, next)}
            repoId={repoId}
            repoMap={repoMap}
            worktrees={worktrees}
          />

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={action.continueOnFailure === true}
              onCheckedChange={(checked) =>
                handleContinueOnFailureChange(action.id, checked === true)
              }
            />
            {translate(
              'auto.components.automations.AutomationActionList.778899aa00',
              'Continue on failure'
            )}
          </label>
        </div>
      ))}
    </div>
  )
}
