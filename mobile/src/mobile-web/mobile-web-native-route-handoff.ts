const MOBILE_WEB_NATIVE_ROUTES = ['terminalSettings', 'connectionLog'] as const

export type MobileWebNativeRoute = (typeof MOBILE_WEB_NATIVE_ROUTES)[number]

export function isMobileWebNativeRoute(destination: string): destination is MobileWebNativeRoute {
  return (MOBILE_WEB_NATIVE_ROUTES as readonly string[]).includes(destination)
}

export class MobileWebNativeRouteHandoff {
  private readonly pending = new Map<string, MobileWebNativeRoute>()

  record(requestId: string, destination: MobileWebNativeRoute): void {
    this.pending.set(requestId, destination)
  }

  consume(requestId: string): MobileWebNativeRoute | null {
    const destination = this.pending.get(requestId) ?? null
    this.pending.delete(requestId)
    return destination
  }

  clear(): void {
    this.pending.clear()
  }
}

export function completeMobileWebNativeRouteHandoffAfterResponse(args: {
  handoff: MobileWebNativeRouteHandoff
  requestId: string
  shouldNavigate?: () => boolean
  deactivateSessionView: () => Promise<void>
  setHostedViewActive: (active: boolean) => void
  navigate: (destination: MobileWebNativeRoute) => void
  onFailure?: (error: unknown, destination: MobileWebNativeRoute) => void
  schedule?: (callback: () => Promise<void>) => void
}): boolean {
  const destination = args.handoff.consume(args.requestId)
  if (!destination) {
    return false
  }
  const schedule = args.schedule ?? ((callback) => setTimeout(() => void callback(), 0))
  schedule(async () => {
    if (!(args.shouldNavigate?.() ?? true)) {
      return
    }
    args.setHostedViewActive(false)
    try {
      await args.deactivateSessionView()
      if (!(args.shouldNavigate?.() ?? true)) {
        args.setHostedViewActive(true)
        return
      }
      args.navigate(destination)
    } catch (error) {
      args.setHostedViewActive(true)
      args.onFailure?.(error, destination)
    }
  })
  return true
}
