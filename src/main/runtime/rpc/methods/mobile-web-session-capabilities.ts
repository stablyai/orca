import { defineMethod } from '../core'

export const MOBILE_WEB_SESSION_CAPABILITIES_METHOD = defineMethod({
  name: 'mobileWeb.session.capabilities',
  params: null,
  handler: (_params, { runtime }) => {
    const status = runtime.getStatus()
    return {
      hostCapabilities: (status.capabilities ?? [])
        .filter((value) => value.length > 0 && value.length <= 120)
        .slice(0, 256),
      floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true
    }
  }
})
