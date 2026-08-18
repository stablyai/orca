import { isConfirmedCursorPathMissing } from '../../shared/cursor-sidecar-path-presence'
import { wslGatedLstat } from '../native-chat/wsl-transcript-fs-access'

export function isMissingCursorPathOnScan(
  path: string,
  error: unknown,
  signal?: AbortSignal
): Promise<boolean> {
  return isConfirmedCursorPathMissing(path, error, (ancestor) =>
    wslGatedLstat(ancestor, 'scan', signal)
  )
}
