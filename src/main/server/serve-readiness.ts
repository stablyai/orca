import type { PairingOfferUnavailableReason } from '../runtime/runtime-rpc'

export type ServePairingUnavailableReason = PairingOfferUnavailableReason | 'disabled_by_operator'

export type ServePairingReadiness =
  | {
      available: true
      url: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
      scope: 'runtime' | 'mobile'
      qr: string | null
    }
  | {
      available: false
      reason: ServePairingUnavailableReason
      guidance: string
    }

export type ServeReadiness = {
  runtimeId: string
  boundEndpoint: string | null
  advertisedEndpoint: string | null
  managedWslCliReconciliation: 'pending' | 'settled' | 'failed'
  pairing: ServePairingReadiness
}

export type ServeReadinessOutput =
  | { mode: 'human' | 'json' }
  | { mode: 'recipe-json'; projectRoot: string }

type ReadinessWrite = (output: string) => Promise<void>

export class ServeReadinessPublisher {
  private state: 'pending' | 'publishing' | 'published' | 'failed' = 'pending'

  constructor(private readonly write: ReadinessWrite = writeStdout) {}

  async publish(readiness: ServeReadiness, output: ServeReadinessOutput): Promise<void> {
    if (this.state !== 'pending') {
      throw new Error(`Serve readiness publication already ${this.state}`)
    }
    this.state = 'publishing'
    try {
      await this.write(`${renderServeReadiness(readiness, output)}\n`)
      this.state = 'published'
    } catch (error) {
      this.state = 'failed'
      throw error
    }
  }
}

export function renderServeReadiness(
  readiness: ServeReadiness,
  output: ServeReadinessOutput
): string {
  if (output.mode === 'recipe-json') {
    if (!readiness.pairing.available) {
      throw new Error(
        `Recipe JSON output requires runtime pairing: ${readiness.pairing.reason}. ${readiness.pairing.guidance}`
      )
    }
    return JSON.stringify({
      schemaVersion: 1,
      pairingCode: readiness.pairing.url,
      projectRoot: output.projectRoot
    })
  }
  if (output.mode === 'json') {
    return JSON.stringify({
      type: 'orca_server_ready',
      schemaVersion: 1,
      runtimeId: readiness.runtimeId,
      endpoint: readiness.boundEndpoint,
      boundEndpoint: readiness.boundEndpoint,
      advertisedEndpoint: readiness.advertisedEndpoint,
      managedWslCliReconciliation: readiness.managedWslCliReconciliation,
      pairing: readiness.pairing
    })
  }
  return renderHumanReadiness(readiness)
}

function renderHumanReadiness(readiness: ServeReadiness): string {
  const lines = [
    'Orca server ready',
    `Bound endpoint: ${readiness.boundEndpoint ?? 'websocket unavailable'}`,
    `Advertised endpoint: ${readiness.advertisedEndpoint ?? 'unavailable'}`
  ]
  if (readiness.pairing.available) {
    if (readiness.pairing.webClientUrl) {
      lines.push(`Web client URL: ${readiness.pairing.webClientUrl}`)
    }
    if (readiness.pairing.scope === 'mobile' && readiness.pairing.qr) {
      lines.push(`Mobile pairing QR:\n${readiness.pairing.qr}`)
    }
    lines.push(`Pairing URL: ${readiness.pairing.url}`)
  } else {
    lines.push(`Pairing unavailable: ${readiness.pairing.reason}`)
    lines.push(`Pairing guidance: ${readiness.pairing.guidance}`)
  }
  return lines.join('\n')
}

function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}
