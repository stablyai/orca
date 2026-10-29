export type OrcadTunnelTransport = 'tcp_forward' | 'stdio_bridge'

const transports = new Map<string, OrcadTunnelTransport>()

export function rememberOrcadTunnelTransport(
  targetId: string,
  transport: OrcadTunnelTransport
): void {
  transports.set(targetId, transport)
}

export function knownOrcadTunnelTransport(targetId: string): OrcadTunnelTransport | null {
  return transports.get(targetId) ?? null
}
