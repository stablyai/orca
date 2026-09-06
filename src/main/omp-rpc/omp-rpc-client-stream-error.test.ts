import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OmpRpcProcessTransportHandlers } from './omp-rpc-process-transport'

const transport = vi.hoisted(() => ({ handlers: null as OmpRpcProcessTransportHandlers | null }))

vi.mock('./omp-rpc-process-transport', () => ({
  OmpRpcProcessTransport: class {
    constructor(_options: unknown, handlers: OmpRpcProcessTransportHandlers) {
      transport.handlers = handlers
    }
    get stderrTail(): string {
      return ''
    }
    write(): boolean {
      return true
    }
    dispose(): void {}
    setMaxLineBytes(): void {}
  }
}))

import { OmpRpcClient } from './omp-rpc-client'

describe('OMP RPC client stream failure', () => {
  beforeEach(() => {
    transport.handlers = null
  })

  it('faults and retires a negotiated client when stdout errors', async () => {
    const client = new OmpRpcClient({
      executablePath: 'omp',
      cwd: '/work',
      sessionMode: 'session-less'
    })
    const events: string[] = []
    client.on((event) => {
      if (event.kind === 'protocol-fault') {
        events.push(event.message)
      }
    })
    transport.handlers?.onLine(
      JSON.stringify({
        type: 'ready',
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        maxFrameBytes: 1_048_576,
        maxReassembledFrameBytes: 67_108_864
      })
    )
    transport.handlers?.onLine(
      JSON.stringify({
        id: 'orca-omp-1',
        type: 'response',
        command: 'negotiate_protocol',
        success: true,
        data: { protocolVersion: 2 }
      })
    )
    await client.whenReady()

    transport.handlers?.onStreamError(new Error('EIO'))

    expect(events).toEqual(['OMP RPC stream error: EIO'])
    expect((client as unknown as { hasProtocolFault: boolean }).hasProtocolFault).toBe(true)
    expect((client as unknown as { isDisposed: boolean }).isDisposed).toBe(true)
  })
})
