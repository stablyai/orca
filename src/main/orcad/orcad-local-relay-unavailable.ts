/** Transport failure only; authentication, protocol, and recovery evidence errors stay distinct. */
export class OrcadLocalRelayUnavailableError extends Error {
  constructor(cause: unknown) {
    super('orcad_local_relay_unverifiable', { cause })
    this.name = 'OrcadLocalRelayUnavailableError'
  }
}

export function classifyOrcadLocalRelaySocketError(error: NodeJS.ErrnoException): Error {
  return [
    'ENOENT',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH'
  ].includes(error.code ?? '')
    ? new OrcadLocalRelayUnavailableError(error)
    : error
}
