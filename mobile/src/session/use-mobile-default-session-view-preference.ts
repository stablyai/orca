import { setDefaultSessionView, useDefaultSessionView } from '../storage/default-session-view-store'
import type { MobileSessionView } from '../storage/session-view-preferences'

export type MobileDefaultSessionViewPreference = {
  defaultView: MobileSessionView
  setDefaultView: (view: MobileSessionView) => void
}

/** The Settings face of the shared default-view store; every mounted session sees a change at once. */
export function useMobileDefaultSessionViewPreference(): MobileDefaultSessionViewPreference {
  const { value } = useDefaultSessionView()
  return { defaultView: value, setDefaultView: setDefaultSessionView }
}
