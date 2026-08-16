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
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { LEAF_3 } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
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

  it('writes the endpoint file with the expected shell-sourceable shape', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'development', userDataPath })
    try {
      const filePath = server.endpointFilePath
      expect(filePath).toBeTruthy()
      expect(existsSync(filePath!)).toBe(true)
      const contents = readFileSync(filePath!, 'utf8')
      const expectedPort = server.buildPtyEnv().ORCA_AGENT_HOOK_PORT
      const expectedToken = server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN
      const prefix = process.platform === 'win32' ? 'set ' : ''
      expect(contents).toContain(`${prefix}ORCA_AGENT_HOOK_PORT=${expectedPort}`)
      expect(contents).toContain(`${prefix}ORCA_AGENT_HOOK_TOKEN=${expectedToken}`)
      expect(contents).toContain(`${prefix}ORCA_AGENT_HOOK_ENV=development`)
      expect(contents).toContain(`${prefix}ORCA_AGENT_HOOK_VERSION=1`)
    } finally {
      server.stop()
    }
  })

  it('writes the endpoint file with owner-only permissions on POSIX', async () => {
    if (process.platform === 'win32') {
      return
    }
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const filePath = server.endpointFilePath!
      // Why: mask to the rwx octet so we assert only the file's mode:0o600, not umask-leaked bits on the parent dir.
      const mode = statSync(filePath).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      server.stop()
    }
  })

  it('rewrites the endpoint file with a new port after restart on the same path', async () => {
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
      // Path is stable (so PTYs stamped before restart can still find the file)
      expect(secondPath).toBe(firstPath)
      // Contents refresh with a new token so stale-env survivors reach the live server.
      expect(secondToken).toBeTruthy()
      expect(secondToken).not.toBe(firstToken)
      const contents = readFileSync(secondPath!, 'utf8')
      // Why: assert on token (randomUUID, can't collide), not port — listen(0) may legitimately reuse the ephemeral port and flake a port check.
      expect(contents).toContain(`ORCA_AGENT_HOOK_PORT=${secondPort}`)
      expect(contents).toContain(`ORCA_AGENT_HOOK_TOKEN=${secondToken}`)
      expect(contents).not.toContain(`ORCA_AGENT_HOOK_TOKEN=${firstToken}`)
    } finally {
      server.stop()
    }
  })

  it('leaves the endpoint file in place on stop()', async () => {
    // Why: stop() leaves the file (stale = fail-open); unlinking would race a concurrent Orca instance rewriting it between token-check and unlink (TOCTOU).
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    const filePath = server.endpointFilePath!
    expect(existsSync(filePath)).toBe(true)
    server.stop()
    expect(existsSync(filePath)).toBe(true)
  })

  it('buildPtyEnv includes ORCA_AGENT_HOOK_ENDPOINT when the server is running', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const env = server.buildPtyEnv()
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBe(server.endpointFilePath)
    } finally {
      server.stop()
    }
  })

  it('buildPtyEnv includes namespaced ORCA_AGENT_HOOK_ENDPOINT for development servers', async () => {
    const server = new AgentHookServer()
    await server.start({
      env: 'development',
      userDataPath,
      endpointNamespace: 'com.stablyai.orca.dev.test123'
    })
    try {
      const env = server.buildPtyEnv()
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBe(server.endpointFilePath)
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toContain('com.stablyai.orca.dev.test123')
      expect(env.ORCA_AGENT_HOOK_PORT).toBeTruthy()
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBeTruthy()
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

  it('buildPtyEnv omits ORCA_AGENT_HOOK_ENDPOINT when no userDataPath was provided', async () => {
    // Why: the endpoint file is opt-in via userDataPath; without it, hooks fall back to v1 behavior (no ENDPOINT key).
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      expect(env.ORCA_AGENT_HOOK_PORT).toBeTruthy()
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBeTruthy()
    } finally {
      server.stop()
    }
  })

  it('buildPtyEnv returns empty when the server is not running', () => {
    const server = new AgentHookServer()
    expect(server.buildPtyEnv()).toEqual({})
  })

  it('sweeps stale .endpoint-*.tmp orphans older than 5 minutes on start', async () => {
    // Why: a crash between tmp-write and rename orphans a tmp; sweep must drop stale ones (>5min) but spare a concurrent writer's fresh in-flight tmp.
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
    // Why: written values are sourced as shell, so isShellSafeEndpointValue must reject metacharacters to prevent command injection.
    const server = new AgentHookServer()
    await server.start({ env: 'bad;value', userDataPath })
    try {
      expect(existsSync(server.endpointFilePath!)).toBe(false)
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
      // PORT/TOKEN still flow via PTY env — fail-open to v1 behavior.
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_PORT).toBeTruthy()
      expect(server.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN).toBeTruthy()
    } finally {
      server.stop()
    }
  })

  it('ingestRemote stamps connectionId and feeds the listener bypassing HTTP', () => {
    const server = new AgentHookServer()
    const events: { paneKey: string; connectionId: string | null; payload: unknown }[] = []
    server.setListener((evt) => {
      events.push({
        paneKey: evt.paneKey,
        connectionId: evt.connectionId,
        payload: evt.payload
      })
    })
    try {
      const remotePane = makePaneKey('tab-3', LEAF_3)
      server.ingestRemote(
        {
          paneKey: remotePane,
          tabId: 'tab-3',
          worktreeId: 'wt-3',
          payload: {
            state: 'working',
            prompt: 'remote prompt',
            agentType: 'claude'
          }
        },
        'conn-42'
      )
      expect(events).toHaveLength(1)
      expect(events[0].paneKey).toBe(remotePane)
      expect(events[0].connectionId).toBe('conn-42')
      expect(events[0].payload).toMatchObject({
        state: 'working',
        prompt: 'remote prompt',
        agentType: 'claude'
      })
    } finally {
      server.setListener(null)
    }
  })

  it('ingestRemote ignores malformed envelopes (fail-open)', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setListener(listener)
    try {
      // Missing paneKey
      server.ingestRemote({ paneKey: '', payload: { state: 'working' } } as never, 'conn-x')
      // Missing payload state
      server.ingestRemote({ paneKey: 'tab-1:0', payload: { foo: 'bar' } }, 'conn-x')
      // Invalid payload state
      server.ingestRemote({ paneKey: 'tab-1:0', payload: { state: 'nonsense' } }, 'conn-x')
      // Empty connection id
      server.ingestRemote({ paneKey: 'tab-1:0', payload: { state: 'working' } }, '  ')
      // Wrong types
      server.ingestRemote(
        { paneKey: 'tab-1:0', payload: 'not-an-object' as unknown } as never,
        'conn-x'
      )
      expect(listener).not.toHaveBeenCalled()
    } finally {
      server.setListener(null)
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
      // Why: source the file exactly as the managed hook script does, catching drift from the KEY=VALUE shape before users do.
      const out = execFileSync('/bin/sh', ['-c', `. "${filePath}" && echo "$ORCA_AGENT_HOOK_PORT"`])
        .toString()
        .trim()
      expect(out).toBe(expectedPort)
    } finally {
      server.stop()
    }
  })
})
