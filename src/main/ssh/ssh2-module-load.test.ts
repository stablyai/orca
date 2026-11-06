import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const nodeRequire = createRequire(import.meta.url)

function isSsh2Loaded(): boolean {
  return Object.keys(nodeRequire.cache).some((path) => /[\\/]node_modules[\\/]ssh2[\\/]/.test(path))
}

describe('ssh2 deferred load', () => {
  it('stays unloaded until an agent is first built, which then extends the real BaseAgent', async () => {
    // The manager reaches connect, auth, channels and file transfers; the rest sit beside it.
    await import('./connection/ssh-connection-manager')
    await import('./port-forwarding/ssh2-port-forward-provider')
    await import('./sftp-upload')
    await import('./sftp-file-upload')
    await import('../providers/ssh-filesystem-provider-sftp')
    const { observeAgentSigning } = await import('./ssh-agent-sign-observer')
    expect(isSsh2Loaded()).toBe(false)

    const agent = observeAgentSigning('/tmp/orca-test-agent.sock', vi.fn())

    expect(agent).toBeInstanceOf(nodeRequire('ssh2').BaseAgent)
  })
})
