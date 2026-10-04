export type RemoteSessionSourceOptions = {
  dshSessionsDir?: string
  includeAntigravityIdeSessions?: boolean
}

export function resolveRemoteSessionSourceOptions(
  options?: boolean | string | RemoteSessionSourceOptions
): RemoteSessionSourceOptions {
  if (typeof options === 'string') {
    return { dshSessionsDir: options }
  }
  if (typeof options === 'boolean') {
    return { includeAntigravityIdeSessions: options }
  }
  return options ?? {}
}
