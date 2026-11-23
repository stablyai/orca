export type NativeActivity = { activityId: string; linkId: string; token: string; state: string }
export type LiveActivityRoute = {
  hostId: string
  worktreeId: string
  paneKey: string
  executionHost?: string
  turnKey: string
}
export type NativeLiveActivities = {
  environment(): Promise<'sandbox' | 'production'>
  hasTurn(route: LiveActivityRoute): Promise<boolean>
  authorization(): Promise<boolean>
  activities(): Promise<NativeActivity[]>
  forgetRoute(linkId: string): Promise<void>
  route(linkId: string): Promise<LiveActivityRoute | null>
  start(
    linkId: string,
    route: LiveActivityRoute,
    title: string,
    labels: Record<string, string>
  ): Promise<string>
  end(activityId: string): Promise<void>
  addListener(
    event: 'onToken' | 'onState',
    listener: (activity: NativeActivity) => void
  ): { remove(): void }
}

export const nativeLiveActivities: NativeLiveActivities | null = null
