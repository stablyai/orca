import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Endpoint file lifecycle', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-endpoint-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('writes the endpoint file with owner-only permissions on POSIX', async () => {
    if (process.platform === 'win32') {
      return
    }
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const filePath = server.endpointFilePath!
      const mode = statSync(filePath).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      server.stop()
    }
  })

  it('rewrites the endpoint file with a new token after restart on the same path', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    const firstPath = server.endpointFilePath
    const firstToken = server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN
    server.stop()

    await server.start({ env: 'production', userDataPath })
    try {
      const secondPath = server.endpointFilePath
      const secondPort = server.buildPtyEnv().ORCA_AGENT_HOOK_PORT
      const secondToken = server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN
      // Surviving PTYs must find the same endpoint path after restart.
      expect(secondPath).toBe(firstPath)
      expect(secondToken).toBeTruthy()
      expect(secondToken).not.toBe(firstToken)
      const contents = readFileSync(secondPath!, 'utf8')
      // Compare regenerated tokens; ephemeral ports may legitimately be reused.
      expect(contents).toContain(`ORCA_AGENT_HOOK_PORT=${secondPort}`)
      expect(contents).toContain(`ORCA_AGENT_HOOK_TOKEN=${secondToken}`)
      expect(contents).not.toContain(`ORCA_AGENT_HOOK_TOKEN=${firstToken}`)
    } finally {
      server.stop()
    }
  })

  it('keeps endpoint files separate for parallel dev namespaces', async () => {
    const firstServer = new AgentHookServer()
    const secondServer = new AgentHookServer()
    await firstServer.start({ env: 'development', userDataPath, endpointNamespace: 'dev-a' })
    await secondServer.start({ env: 'development', userDataPath, endpointNamespace: 'dev-b' })
    try {
      expect(firstServer.endpointFilePath).not.toBe(secondServer.endpointFilePath)
      expect(firstServer.buildPtyEnv().ORCA_AGENT_HOOK_ENDPOINT).toBe(firstServer.endpointFilePath)
      expect(secondServer.buildPtyEnv().ORCA_AGENT_HOOK_ENDPOINT).toBe(
        secondServer.endpointFilePath
      )
      expect(existsSync(firstServer.endpointFilePath!)).toBe(true)
      expect(existsSync(secondServer.endpointFilePath!)).toBe(true)
    } finally {
      firstServer.stop()
      secondServer.stop()
    }
  })

  it('sweeps stale .endpoint-*.tmp orphans older than 5 minutes on start', async () => {
    // Sweep crash residue while preserving fresh temporary files from concurrent writers.
    const dir = join(userDataPath, 'agent-hooks')
    mkdirSync(dir, { recursive: true })
    const staleTmp = join(dir, '.endpoint-999-stale.tmp')
    const freshTmp = join(dir, '.endpoint-999-fresh.tmp')
    writeFileSync(staleTmp, 'stale')
    writeFileSync(freshTmp, 'fresh')
    const sixMinAgo = (Date.now() - 6 * 60 * 1000) / 1000
    utimesSync(staleTmp, sixMinAgo, sixMinAgo)

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(existsSync(staleTmp)).toBe(false)
      expect(existsSync(freshTmp)).toBe(true)
    } finally {
      server.stop()
    }
  })

  it('refuses to write the endpoint file when a value contains shell metacharacters', async () => {
    // Endpoint values are sourced as shell, so metacharacters must be rejected.
    const server = new AgentHookServer()
    await server.start({ env: 'bad;value', userDataPath })
    try {
      expect(existsSync(server.endpointFilePath!)).toBe(false)
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_PORT).toBeTruthy()
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN).toBeTruthy()
    } finally {
      server.stop()
    }
  })

  it('endpoint file contents are re-parseable by /bin/sh', async () => {
    if (process.platform === 'win32') {
      return
    }
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const filePath = server.endpointFilePath!
      const expectedPort = server.buildPtyEnv().ORCA_AGENT_HOOK_PORT
      const out = execFileSync('/bin/sh', ['-c', `. "${filePath}" && echo "$ORCA_AGENT_HOOK_PORT"`])
        .toString()
        .trim()
      expect(out).toBe(expectedPort)
    } finally {
      server.stop()
    }
  })
})
