// CR-EVM-006/FE-TASK-EVM-004: surfaces doctorRuntimeEphemeralVmRecipe's
// conflict checks before a workspace is provisioned from a recipe.
// `blocking` (any check.status === 'fail') hides the "Continue anyway"
// action — the caller must fix the recipe first, matching
// doctorEphemeralVmRecipe's `ok` computation (every check !== 'fail').
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { EphemeralVmRecipeDoctorCheck } from '../../../../shared/ephemeral-vm-recipes'

export function EphemeralVmRecipeDoctorDialog({
  open,
  onOpenChange,
  onContinue,
  checks,
  blocking
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onContinue: () => void
  checks: EphemeralVmRecipeDoctorCheck[]
  blocking: boolean
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground" />
            {blocking
              ? translate(
                  'auto.components.settings.EphemeralVmRecipeDoctorDialog.blockingTitle',
                  'This recipe has a problem'
                )
              : translate(
                  'auto.components.settings.EphemeralVmRecipeDoctorDialog.warnTitle',
                  'This recipe has a warning'
                )}
          </DialogTitle>
          <DialogDescription>
            {blocking
              ? translate(
                  'auto.components.settings.EphemeralVmRecipeDoctorDialog.blockingDescription',
                  'Fix the issue below before using this recipe.'
                )
              : translate(
                  'auto.components.settings.EphemeralVmRecipeDoctorDialog.warnDescription',
                  'You can continue, but review the warning below first.'
                )}
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 text-sm">
          {checks
            .filter((check) => check.status !== 'pass')
            .map((check) => (
              <li key={check.id} className="rounded-md border border-border bg-muted/40 px-3 py-2">
                <div className="font-medium text-foreground">{check.message}</div>
                {check.remediation ? (
                  <div className="mt-1 text-xs text-muted-foreground">{check.remediation}</div>
                ) : null}
              </li>
            ))}
        </ul>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {translate('auto.components.settings.EphemeralVmRecipeDoctorDialog.cancel', 'Cancel')}
          </Button>
          {blocking ? null : (
            <Button size="sm" onClick={onContinue}>
              {translate(
                'auto.components.settings.EphemeralVmRecipeDoctorDialog.continue',
                'Continue anyway'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
