import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

export function InjectionConfirmDialog({
  open,
  onOpenChange,
  issueTitle,
  onConfirm,
  onCancel
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  issueTitle: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Inject Issue Content?</DialogTitle>
          <DialogDescription>
            Would you like to inject &quot;{issueTitle}&quot; into the agent chat?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Skip
          </Button>
          <Button onClick={onConfirm}>
            Inject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
