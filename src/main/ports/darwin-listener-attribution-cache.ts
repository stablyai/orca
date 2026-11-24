import type { RawListeningPort } from './local-workspace-port-scan-state'

// A handed-off socket keeps its identity and its old owner alive, so run lsof at least every 10th scan.
const MAX_REUSED_DARWIN_SCANS = 9

// Last lsof attribution and the netstat socket signature it was taken under.
let lastDarwinAttribution: {
  socketSignature: string
  ports: RawListeningPort[]
  reusedScans: number
} | null = null

/** lsof walks every process; reuse its last answer while netstat shows the same LISTEN sockets and their owners live. */
export function reusableDarwinAttribution(
  socketSignature: string | null
): RawListeningPort[] | null {
  const cached = lastDarwinAttribution
  if (
    socketSignature === null ||
    cached?.socketSignature !== socketSignature ||
    cached.reusedScans >= MAX_REUSED_DARWIN_SCANS ||
    !cached.ports.every((port) => port.pid === undefined || isProcessAlive(port.pid))
  ) {
    lastDarwinAttribution = null
    return null
  }
  cached.reusedScans += 1
  return cached.ports
}

export function rememberDarwinAttribution(
  socketSignature: string | null,
  ports: RawListeningPort[]
): void {
  lastDarwinAttribution =
    socketSignature === null ? null : { socketSignature, ports, reusedScans: 0 }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}
