/** Which transport each host's managed tunnel last started on, for connect telemetry. */
export type OrcadTunnelTransport = 'tcp_forward' | 'stdio_bridge'

// Keyed by the local target id, which never leaves this process.
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
