import type React from 'react'
import { LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { LinearIssueLabel, LinearTeam } from '../../../shared/types'
import type { LabelFormState } from './linear-label-form-model'

type LinearLabelFormDialogProps = {
  open: boolean
  form: LabelFormState
  teams: LinearTeam[]
  parentOptions: LinearIssueLabel[]
  submitting: boolean
  onOpenChange: (open: boolean) => void
  onFormChange: React.Dispatch<React.SetStateAction<LabelFormState>>
  onSubmit: () => void
}

export function LinearLabelFormDialog({
  open,
  form,
  teams,
  parentOptions,
  submitting,
  onOpenChange,
  onFormChange,
  onSubmit
}: LinearLabelFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !submitting && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{form.id ? 'Edit Linear label' : 'New Linear label'}</DialogTitle>
          <DialogDescription>Manage the label definition used by Linear issues.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
            Name
            <Input
              value={form.name}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, name: event.target.value }))
              }
              disabled={submitting}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
            Color
            <Input
              value={form.color}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, color: event.target.value }))
              }
              disabled={submitting}
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
            Description
            <Input
              value={form.description}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, description: event.target.value }))
              }
              disabled={submitting}
            />
          </label>
          {!form.id ? (
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              Scope
              <Select
                value={form.teamId}
                onValueChange={(value) =>
                  onFormChange((current) => ({ ...current, teamId: value }))
                }
                disabled={submitting}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="workspace">Workspace</SelectItem>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.key} — {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
            Parent group
            <Select
              value={form.parentId}
              onValueChange={(value) =>
                onFormChange((current) => ({ ...current, parentId: value }))
              }
              disabled={submitting}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {parentOptions.map((label) => (
                  <SelectItem key={label.id} value={label.id}>
                    {label.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={form.isGroup}
              onChange={(event) =>
                onFormChange((current) => ({ ...current, isGroup: event.target.checked }))
              }
              disabled={submitting}
              className="size-4 rounded border-border bg-background"
            />
            Label group
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={submitting || !form.name.trim()}>
            {submitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {form.id ? 'Save label' : 'Create label'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
