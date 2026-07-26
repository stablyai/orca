export type HelloMessage = {
  type: 'hello'
  version: number
  token: string
  clientId: string
  role: 'control' | 'stream'
}

export type DaemonEndpointIdentity = {
  pid: number
  startedAtMs: number
  launchNonce: string
}

export type HelloResponse = {
  type: 'hello'
  ok: boolean
  error?: string
  daemonIdentity?: DaemonEndpointIdentity
}
