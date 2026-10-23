import { Button } from './ui/Button'

/**
 * What the banner offers once authentication has failed: reconnect, re-pair, or drop the pairing.
 * Remove opens the screen's confirm before anything is forgotten.
 *
 * Its own file because its `.web` sibling offers Re-pair alone: the page hands `/pair-scan` to the
 * shell, but its `forceReconnect` is null (`client-context.web.tsx`) and removal refuses
 * (`page-host-removal-refusal.ts`).
 */
export function AuthFailedBannerActions({
  canRetry,
  onRetry,
  onRepair,
  onRemove
}: {
  canRetry: boolean
  onRetry: () => void
  onRepair: () => void
  onRemove: () => void
}) {
  return (
    <>
      {canRetry && <Button label="Retry" size="compact" onPress={onRetry} />}
      <Button label="Re-pair" size="compact" onPress={onRepair} />
      <Button label="Remove" size="compact" variant="destructive" onPress={onRemove} />
    </>
  )
}
