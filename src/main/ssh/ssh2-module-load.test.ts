import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

// The unit-test setup mocks this loader; use the real one to guard the startup deferral (#35731).
vi.unmock('./ssh2-module-load')

const nodeRequire = createRequire(import.meta.url)

function isSsh2Loaded(): boolean {
  return Object.keys(nodeRequire.cache).some((path) => /[\\/]node_modules[\\/]ssh2[\\/]/.test(path))
}

describe('ssh2 deferred load', () => {
  it('stays unloaded until an agent is first built, which then extends the real BaseAgent', async () => {
    await import('./connection/ssh2-handshake')
    await import('./ssh-auth-resolution')
    await import('./ssh-agent-identity-filter')
    await import('./ssh-host-key-verifier')
    const { observeAgentSigning } = await import('./ssh-agent-sign-observer')
    expect(isSsh2Loaded()).toBe(false)

    const agent = observeAgentSigning('/tmp/orca-test-agent.sock', vi.fn())

    expect(agent).toBeInstanceOf(nodeRequire('ssh2').BaseAgent)
  })
})
