type PopupFixtureSecurity = {
  sandbox: boolean
  contextIsolation: boolean
  nodeIntegration: boolean
}

export type PopupCompatibilityStatus = {
  electronVersion: string
  adapterProbe?: Record<string, unknown>[]
  revision: number
  ready?: boolean
  error?: string
  windowsHidden: boolean
  tabOpens: { url: string; activate: boolean }[]
  blocked: number[]
  inputs: string[]
  childRequests: {
    adopted: boolean
    native: boolean
    sessionMatches: boolean
    security: PopupFixtureSecurity
    permission?: string
  }[]
  routeGranted: boolean
  routeContents: { security: PopupFixtureSecurity; webRtcPolicy: string }[]
  native: {
    presentationCalls: string[]
    requests: { disposition: string; features: string; frameName: string; post: boolean }[]
    creation: {
      firstNavigationPolicy: string
      firstNavigationOwner: number | null
      firstNavigationTitle: string
    }[]
    windows: {
      closed: boolean
      title: string
      fullscreen: boolean
      focused: boolean
      contentSize: number[]
    }[]
  }
}
