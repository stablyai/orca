import type { ProcessSpec } from '@orca/process-host/process-spec'
import type { superviseForegroundServe } from './serve-update-supervisor'
import { createInterface } from 'node:readline'

export const PAIRING_HIDDEN_LINE =
  'Pairing URL: hidden because this supervised server is not writing to a terminal. Pair from the desktop app, or run `orca serve` in a terminal.'

/** Remove readiness pairing secrets, retaining state for multiline QR output. */
export function createPairingRedactor(): (line: string) => string | null {
  let inQr = false
  return (line) => {
    if (line.startsWith('{') && line.includes('"orca_server_ready"')) {
      return redactReadyJson(line)
    }
    if (line.startsWith('Mobile pairing QR:')) {
      inQr = true
      return null
    }
    if (line.startsWith('Pairing URL: ')) {
      inQr = false
      return PAIRING_HIDDEN_LINE
    }
    if (inQr || line.startsWith('Web client URL: ')) {
      return null
    }
    return line
  }
}

function redactReadyJson(line: string): string {
  try {
    const ready: unknown = JSON.parse(line)
    if (typeof ready === 'object' && ready !== null && 'pairing' in ready) {
      return JSON.stringify({
        ...ready,
        pairing: { available: false, reason: 'hidden', guidance: PAIRING_HIDDEN_LINE }
      })
    }
  } catch {}
  return line
}

/** Redact service logs; plain serve retains pairing stdout for scripts. */
export function shouldRedactSupervisedStdout(
  supervise: boolean,
  stdoutIsTty: boolean = process.stdout.isTTY === true
): boolean {
  return supervise && !stdoutIsTty
}

let stdoutErrorsIgnored = false

export type ServeSpawnChild = Parameters<typeof superviseForegroundServe>[0]['spawnChild']

export function redactingSpawn(spawn: ServeSpawnChild): ServeSpawnChild {
  return (spec) => {
    const stdio: ProcessSpec['stdio'] = Array.isArray(spec.stdio)
      ? spec.stdio.map((slot, index) => (index === 1 ? 'pipe' : slot))
      : ['inherit', 'pipe', 'inherit']
    const child = spawn({ ...spec, stdio })
    if (child.stdout) {
      // Closed log pipes must not crash the supervisor.
      child.stdout.on('error', () => undefined)
      if (!stdoutErrorsIgnored) {
        stdoutErrorsIgnored = true
        process.stdout.on('error', () => undefined)
      }
      const redact = createPairingRedactor()
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
      lines.on('line', (line) => {
        const kept = redact(line)
        if (kept !== null) {
          process.stdout.write(`${kept}\n`)
        }
      })
    }
    return child
  }
}
