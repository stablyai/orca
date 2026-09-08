// src/relay/__tests__/agent-spawn-reconnect.integration.test.ts
//
// CR-STORAGE-008(b) / SOL-AG-STORAGE-003 / TASK-AG-STORAGE-006+007.
//
// End-to-end regression test for the fix to ORCH-011's "kill every
// agent.spawn PTY on any WS disconnect" behavior: a transient disconnect
// must no longer kill in-flight AI-agent CLI work, and output must resume
// flowing once the agent reconnects — mirroring the terminal-PTY daemon's
// already-proven grace-period behavior (pty-agent-bridge.test.ts), adapted
// for agent-spawner.ts's in-process (non-daemon) PTY_REGISTRY.
//
// Drives the real dispatch path (agent-session.ts + agent-rpc-dispatch* +
// agent-spawner.ts) via simulated wire frames, exactly like
// agent-session.test.ts's existing handshake tests — only node-pty is
// mocked (native module, unavailable in the test environment).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import { createSession } from '../agent-session'
import { HEADER_SIZE } from 'orca-dev-agent-transport'
import type { AgentConfig } from '../agent-config'
import type { AgentLogger } from '../agent-logger'
import { AGENT_SPAWN_PTY_GRACE_PERIOD_MS } from '../agent-spawner'

// ── Fake node-pty (mirrors agent-spawner.test.ts's helper) ───────────────────
type FakeAgentPty = {
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number }) => void) => void
  kill: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
}
function makeFakeAgentPty(): FakeAgentPty {
  let dataCb: ((data: string) => void) | null = null
  let exitCb: ((e: { exitCode: number }) => void) | null = null
  return {
    onData: (cb) => {
      dataCb = cb
    },
    onExit: (cb) => {
      exitCb = cb
    },
    kill: vi.fn(),
    write: vi.fn(),
    emitData: (data) => dataCb?.(data),
    emitExit: (exitCode) => exitCb?.({ exitCode })
  }
}
let lastSpawnedAgentPty: FakeAgentPty | null = null
const agentSpawnMock = vi.fn((..._args: unknown[]) => {
  lastSpawnedAgentPty = makeFakeAgentPty()
  return lastSpawnedAgentPty
})
vi.mock('node-pty', () => ({ spawn: agentSpawnMock }))

// ── MockWs (mirrors agent-session.test.ts's helper) ───────────────────────────
class MockWs extends EventEmitter {
  readyState = 1 // WebSocket.OPEN
  send = vi.fn()
  close = vi.fn()
  ping = vi.fn()
  terminate = vi.fn()
}
const WS_CLOSED = 3

function buildFrame(payloadObj: object): Buffer {
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8')
  const header = Buffer.allocUnsafe(HEADER_SIZE)
  header.writeUInt8(1, 0)
  header.writeUInt32BE(1, 1)
  header.writeUInt32BE(0, 5)
  header.writeUInt32BE(payload.length, 9)
  return Buffer.concat([header, payload])
}

function extractNotifications(ws: MockWs, method: string): Record<string, unknown>[] {
  return ws.send.mock.calls
    .map((call) => {
      const buf = call[0] as Buffer
      try {
        return JSON.parse(buf.subarray(HEADER_SIZE).toString('utf8')) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((rpc): rpc is Record<string, unknown> => rpc !== null && rpc.method === method)
}

const mockConfig: AgentConfig = {
  mode: 'direct-websocket',
  orcaUrl: 'wss://test',
  orcaHttpUrl: '',
  agentToken: 'tok-test',
  apiSecret: '',
  agentPort: 6799,
  devServerId: 'test-server',
  logLevel: 'info',
  workDir: '/tmp',
  toolPath: '', // empty → binaryExists check short-circuits true (see agent-spawner.test.ts)
  toolEnv: {},
  credentialDir: '/tmp/.creds',
  tlsRejectUnauthorized: true
}

const mockLog: AgentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const MOCK_CAPS = ['fs', 'git', 'preflight', 'ai.providers', 'agent.spawn', 'worktrees'] as const

/** Starts a session, completes its handshake (result.ok=true), and returns it. */
function startAndHandshake(ws: MockWs) {
  const session = createSession(mockConfig, [], mockLog, MOCK_CAPS)
  session.start(ws as unknown as WebSocket)
  ws.emit(
    'message',
    buildFrame({ jsonrpc: '2.0', id: 1, result: { ok: true, sessionId: 's1', orcaVersion: '1.0' } })
  )
  return session
}

/** Sends an agent.spawn RPC request frame and returns the ptyId from the
 *  fire-and-forget "spawn.accepted" response — mirrors what a real Orca
 *  server round-trip looks like from the agent's perspective. */
async function spawnAgent(ws: MockWs, taskId: string): Promise<string> {
  ws.emit(
    'message',
    buildFrame({
      jsonrpc: '2.0',
      id: 2,
      method: 'agent.spawn',
      params: { model: 'claude', taskId, userId: 'user-1', cwd: '/tmp' }
    })
  )
  // handleAgentSpawn does async work (buildAgentEnv, dynamic imports) before
  // registering the PTY — let it settle.
  await vi.waitFor(() => {
    if (!lastSpawnedAgentPty) {
      throw new Error('pty not spawned yet')
    }
  })
  return `pty-user-1-${taskId}` // best-effort; not asserted on directly below
}

describe('CR-STORAGE-008(b): agent.spawn PTY survives a transient disconnect and resumes on reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    lastSpawnedAgentPty = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT kill the PTY when the WS closes with a non-1000 code (grace period armed instead)', async () => {
    const ws = new MockWs()
    startAndHandshake(ws)
    await spawnAgent(ws, 'task-grace-1')
    const pty = lastSpawnedAgentPty!

    ws.readyState = WS_CLOSED
    ws.emit('close', 1006, Buffer.from('abnormal closure'))

    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('kills the PTY once the grace period fully elapses with no reconnect', async () => {
    const ws = new MockWs()
    startAndHandshake(ws)
    await spawnAgent(ws, 'task-grace-2')
    const pty = lastSpawnedAgentPty!

    ws.readyState = WS_CLOSED
    ws.emit('close', 1006, Buffer.from('abnormal closure'))
    expect(pty.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(AGENT_SPAWN_PTY_GRACE_PERIOD_MS + 1000)

    expect(pty.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('cancels the grace timer and resumes delivering output on a reconnect within the grace period', async () => {
    const ws1 = new MockWs()
    startAndHandshake(ws1)
    await spawnAgent(ws1, 'task-resume-1')
    const pty = lastSpawnedAgentPty!

    // Disconnect — grace period arms, PTY stays alive.
    ws1.readyState = WS_CLOSED
    ws1.emit('close', 1006, Buffer.from('abnormal closure'))
    expect(pty.kill).not.toHaveBeenCalled()

    // A little time passes (well within the grace period), then the agent
    // process reconnects — a brand-new session/WebSocket, same process
    // (same PTY_REGISTRY singleton), exactly like connectDirect()'s real
    // reconnect loop constructing a fresh createSession() per attempt.
    await vi.advanceTimersByTimeAsync(5_000)
    const ws2 = new MockWs()
    startAndHandshake(ws2)

    // Grace period must be cancelled — advancing well past the original
    // window must NOT kill the PTY now that a live connection exists again.
    await vi.advanceTimersByTimeAsync(AGENT_SPAWN_PTY_GRACE_PERIOD_MS + 1000)
    expect(pty.kill).not.toHaveBeenCalled()

    // Output emitted after the reconnect must reach the NEW connection, not
    // be silently dropped (the old ws1 is dead) or sent to the dead ws1.
    ws2.send.mockClear()
    pty.emitData('hello after reconnect')
    const notifications = extractNotifications(ws2, 'agent.output')
    expect(notifications.length).toBeGreaterThan(0)
    expect(
      Buffer.from((notifications[0]!.params as { data: string }).data, 'base64').toString('utf8')
    ).toBe('hello after reconnect')
    expect(extractNotifications(ws1, 'agent.output')).toHaveLength(0)
  })
})
