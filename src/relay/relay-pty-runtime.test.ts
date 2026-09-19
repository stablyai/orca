import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadRelayPtyRuntime } from './relay-pty-runtime'

describe('relay PTY runtime selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('uses the Bun terminal backend when the relay is launched by Bun', async () => {
    vi.stubGlobal('Bun', {
      Terminal: class Terminal {},
      spawn: vi.fn()
    })

    await expect(loadRelayPtyRuntime()).resolves.toMatchObject({
      runtimeKind: 'bun',
      ptyBackend: 'bun-terminal'
    })
  })

  it('keeps node-pty as the compatibility backend under Node', async () => {
    await expect(loadRelayPtyRuntime()).resolves.toMatchObject({
      runtimeKind: 'node',
      ptyBackend: 'node-pty'
    })
  })

  it('does not fall back to node-pty when Bun is present but its terminal API is unavailable', async () => {
    vi.stubGlobal('Bun', { spawn: vi.fn() })

    await expect(loadRelayPtyRuntime({ skipNode: true })).resolves.toBeNull()
  })
})
