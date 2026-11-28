import type { MobileSessionFoundationModel } from '../session/use-mobile-session-foundation'
import type { MobileSessionTab } from '../session/tabs/mobile-session-tabs'

export function useSessionLiveActivity(
  _model: Pick<MobileSessionFoundationModel, 'worktreeId'> & {
    activeSessionTab: MobileSessionTab | null | undefined
  }
): void {}
