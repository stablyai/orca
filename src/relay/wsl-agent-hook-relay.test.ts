// Guest-side WSL hook relay pieces: host-given port/token binding with
// ephemeral fallback, and the shared endpoint-path contract.
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RelayAgentHookServer } from './agent-hook-server'
import { makePaneKey } from '../shared/stable-pane-id'
import {
  sanitizeWslHookInstanceKey,
  wslHookRelayEndpointDir,
  wslHookRelayEndpointFilePath
} from '../shared/wsl-hook-relay-contract'

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey('tab-2', LEAF_ID)

// Parse an endpoint file tolerantly across platforms: POSIX writes `KEY=value`,
// Windows writes `set KEY=value`. Strips the optional `set ` prefix.
function parseEndpointFile(contents: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/^set /, '')
    const eq = line.indexOf('=')
    if (eq > 0) {
      env[line.slice(0, eq)] = line.slice(eq + 1)
    }
  }
  return env
}

describe('RelayAgentHookServer host-given coordinates (WSL relay)', () => {
  let tmpDir: string
  let server: RelayAgentHookServer | null

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wsl-hook-relay-'))
    server = null
  })

  afterEach(() => {
    server?.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('binds the preferred port with the fixed token when the port is free', async () => {
    const probe = createServer()
    const freePort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    server = new RelayAgentHookServer({
      endpointDir: tmpDir,
      token: 'host-issued-token',
      preferredPort: freePort,
      forward: () => {}
    })
    await server.start()

    expect(server.getCoordinates().port).toBe(freePort)
    expect(server.getCoordinates().token).toBe('host-issued-token')
    expect(server.usedPortFallback).toBe(false)
  })

  it('falls back to an ephemeral port when the preferred port is occupied', async () => {
    const occupant = createServer()
    const occupiedPort = await new Promise<number>((resolve) => {
      occupant.listen(0, '127.0.0.1', () => {
        const address = occupant.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    try {
      server = new RelayAgentHookServer({
        endpointDir: tmpDir,
        token: 'host-issued-token',
        preferredPort: occupiedPort,
        forward: () => {}
      })
      await server.start()

      expect(server.usedPortFallback).toBe(true)
      const bound = server.getCoordinates().port
      expect(bound).toBeGreaterThan(0)
      expect(bound).not.toBe(occupiedPort)
      // Fallback still authenticates with the host-issued token.
      expect(server.getCoordinates().token).toBe('host-issued-token')
    } finally {
      await new Promise<void>((resolve) => occupant.close(() => resolve()))
    }
  })

  it('keeps random-token ephemeral behavior when no coordinates are given (SSH shape)', async () => {
    server = new RelayAgentHookServer({ endpointDir: tmpDir, forward: () => {} })
    await server.start()
    expect(server.getCoordinates().port).toBeGreaterThan(0)
    expect(server.getCoordinates().token).toMatch(/^[0-9a-f-]{36}$/)
    expect(server.usedPortFallback).toBe(false)
  })

  it('rejects a wrong token but authenticates the host-issued fixed token', async () => {
    const forward = vi.fn()
    server = new RelayAgentHookServer({ endpointDir: tmpDir, token: 'host-issued-token', forward })
    await server.start()
    const { port } = server.getCoordinates()

    const rejected = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': 'wrong-token' },
      body: '{}'
    })
    expect(rejected.status).toBe(403)
    expect(forward).not.toHaveBeenCalled()

    const accepted = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': 'host-issued-token'
      },
      body: JSON.stringify({
        paneKey: PANE_KEY,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }
      })
    })
    expect(accepted.status).toBe(204)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward.mock.calls[0][0].paneKey).toBe(PANE_KEY)
  })

  it('publishes the fallback port + fixed token into the endpoint file after EADDRINUSE', async () => {
    const occupant = createServer()
    const occupiedPort = await new Promise<number>((resolve) => {
      occupant.listen(0, '127.0.0.1', () => {
        const address = occupant.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    try {
      server = new RelayAgentHookServer({
        endpointDir: tmpDir,
        token: 'host-issued-token',
        preferredPort: occupiedPort,
        forward: () => {}
      })
      await server.start()

      expect(server.usedPortFallback).toBe(true)
      const { port, token, endpointFilePath } = server.getCoordinates()
      expect(port).not.toBe(occupiedPort)

      // The endpoint file is the client re-coordination contract: surviving
      // agents re-source it and MUST see the actual fallback port, not the
      // occupied preferred port.
      const published = parseEndpointFile(readFileSync(endpointFilePath, 'utf8'))
      expect(published.ORCA_AGENT_HOOK_PORT).toBe(String(port))
      expect(published.ORCA_AGENT_HOOK_PORT).not.toBe(String(occupiedPort))
      expect(published.ORCA_AGENT_HOOK_TOKEN).toBe(token)
      expect(published.ORCA_AGENT_HOOK_TOKEN).toBe('host-issued-token')
    } finally {
      await new Promise<void>((resolve) => occupant.close(() => resolve()))
    }
  })
})

describe('wsl hook relay endpoint contract', () => {
  it('derives the endpoint dir from guest home and the restart-stable instance key', () => {
    expect(wslHookRelayEndpointDir('/home/u', 'abc123')).toBe(
      '/home/u/.orca-wsl/agent-hooks/instance-abc123'
    )
    expect(wslHookRelayEndpointDir('/home/u/', 'abc123')).toBe(
      '/home/u/.orca-wsl/agent-hooks/instance-abc123'
    )
  })

  it('names the guest endpoint file endpoint.env regardless of host platform', () => {
    expect(wslHookRelayEndpointFilePath('/home/u', 'k1')).toBe(
      '/home/u/.orca-wsl/agent-hooks/instance-k1/endpoint.env'
    )
  })

  it('sanitizes instance keys to a shell/path-inert alphabet', () => {
    expect(sanitizeWslHookInstanceKey('ABCdef012')).toBe('abcdef012')
    expect(sanitizeWslHookInstanceKey('  a-1  ')).toBe('a-1')
    expect(sanitizeWslHookInstanceKey('bad key$')).toBeNull()
    expect(sanitizeWslHookInstanceKey('')).toBeNull()
    expect(sanitizeWslHookInstanceKey(undefined)).toBeNull()
  })
})
