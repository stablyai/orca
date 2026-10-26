import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { withoutSessionTabs } from './session-tab-browser-placement-projection'

/** A desktop's tab on a file of one of its servers is for its phone, which reaches that server through
 *  the desktop. Another runtime would route the file here, and in a pairing cycle it is that runtime's
 *  own workspace coming back to it (#33424). */
export function projectSessionTabFileHosts(
  payload: RuntimeMobileSessionTabsResult,
  clientKind: 'mobile' | 'runtime' | undefined
): RuntimeMobileSessionTabsResult {
  const hosted = new Set(
    payload.tabs.filter((tab) => 'hostRuntimeEnvironmentId' in tab).map((tab) => tab.id)
  )
  if (hosted.size === 0) {
    return payload
  }
  const stripped = {
    ...payload,
    tabs: payload.tabs.map((tab) => {
      if (!('hostRuntimeEnvironmentId' in tab)) {
        return tab
      }
      const { hostRuntimeEnvironmentId: _host, ...served } = tab
      return served
    })
  }
  return clientKind === 'runtime' ? withoutSessionTabs(stripped, hosted) : stripped
}
