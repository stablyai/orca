import type { RuntimePortForwardOpenRequest } from '../../shared/runtime-port-forwards'

export function forwardKey(environmentId: string, remotePort: number): string {
  return `${environmentId}\u0000${remotePort}`
}

function isPort(value: unknown, allowZero: boolean): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= 65_535
  )
}

export function isValidRuntimePortForwardRequest(request: RuntimePortForwardOpenRequest): boolean {
  return (
    typeof request.environmentId === 'string' &&
    request.environmentId.length > 0 &&
    isPort(request.remotePort, false) &&
    (request.localPort === undefined || isPort(request.localPort, true)) &&
    (request.reason === 'user' || request.reason === 'auto' || request.reason === 'ssh')
  )
}
