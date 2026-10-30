type RouteIdentity = {
  v: 1
  platform: 'ios' | 'android'
  apnsEnvironment?: 'sandbox' | 'production'
  token: string
  routeKey: string
}
export type PushRouteContent = RouteIdentity &
  (
    | { action: 'read' }
    | {
        action: 'replace'
        version: number
        expectedVersion: number | null
        hosts: readonly string[]
      }
  )
export function pushRouteDeclarationContent(value: PushRouteContent): string {
  return JSON.stringify({
    action: value.action,
    ...(value.apnsEnvironment ? { apnsEnvironment: value.apnsEnvironment } : {}),
    ...(value.action === 'replace'
      ? { expectedVersion: value.expectedVersion, hosts: [...new Set(value.hosts)].sort() }
      : {}),
    platform: value.platform,
    routeKey: value.routeKey,
    token: value.token,
    v: value.v,
    ...(value.action === 'replace' ? { version: value.version } : {})
  })
}
