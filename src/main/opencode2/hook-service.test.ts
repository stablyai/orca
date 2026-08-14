import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenCode2HookService } from './hook-service'

// Why: the hook service reads the daemon registration file and the SSE stream;
// both are faked here so the translation + attribution logic is exercised
// without a running opencode2 daemon.

const { agentHookServerMock } = vi.hoisted(() => ({
  agentHookServerMock: {
    ingestTerminalStatus: vi.fn(),
    onInterruptInferred: null as
      | ((args: {
          paneKey: string
          agentType?: string
          providerSession?: { key: string; id: string }
        }) => void)
      | null
  }
}))

vi.mock('../agent-hooks/server', () => ({
  agentHookServer: agentHookServerMock
}))

let tempDirs: string[] = []
let service: OpenCode2HookService

function writeServiceFile(): void {
  const stateDir = mkdtempSync(join(tmpdir(), 'orca-opencode2-hook-'))
  tempDirs.push(stateDir)
  const dir = join(stateDir, 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'service.json'),
    JSON.stringify({ url: 'http://127.0.0.1:4096', password: 'pw' }),
    'utf8'
  )
  // Why: the service reads the registration file from XDG_STATE_HOME.
  vi.stubEnv('XDG_STATE_HOME', stateDir)
}

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    }
  })
}

function envelope(event: string, data: unknown): string {
  return `data: ${JSON.stringify({ event, data: JSON.stringify(data) })}\n\n`
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  // Why: a fresh instance keeps every test free of earlier cache/stream state.
  service = new OpenCode2HookService()
  agentHookServerMock.onInterruptInferred = null
  agentHookServerMock.ingestTerminalStatus.mockClear()
})

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('OpenCode2HookService', () => {
  it('attributes daemon sessions to terminals by directory and ingests status', async () => {
    writeServiceFile()
    const streamed = [
      envelope('session.created', {
        sessionID: 'session_1',
        location: { directory: '/repo' }
      }),
      envelope('session.status', {
        sessionID: 'session_1',
        status: { type: 'busy' }
      })
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string) => {
        if (_url.endsWith('/api/event')) {
          return { ok: true, status: 200, body: sseBody(streamed) }
        }
        return { ok: false, status: 404 }
      })
    )

    service.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })
    await flush()

    const ingest = agentHookServerMock.ingestTerminalStatus.mock.calls
    expect(ingest.length).toBeGreaterThanOrEqual(1)
    const last = ingest.at(-1)![0]
    expect(last.paneKey).toBe('tab_1:leaf_1')
    expect(last.payload.state).toBe('working')
    expect(last.providerSession).toEqual({ key: 'session_id', id: 'session_1' })
  })

  it('maps session.status idle to a done state', async () => {
    writeServiceFile()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string) => ({
        ok: true,
        status: 200,
        body: sseBody([
          envelope('session.created', {
            sessionID: 'session_1',
            location: { directory: '/repo' }
          }),
          envelope('session.status', {
            sessionID: 'session_1',
            status: { type: 'idle' }
          })
        ])
      }))
    )

    service.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })
    await flush()

    const last = agentHookServerMock.ingestTerminalStatus.mock.calls.at(-1)![0]
    expect(last.payload.state).toBe('done')
  })

  it('ignores sessions whose directory belongs to no Orca terminal', async () => {
    writeServiceFile()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string) => ({
        ok: true,
        status: 200,
        body: sseBody([
          envelope('session.created', {
            sessionID: 'session_other',
            location: { directory: '/other-repo' }
          }),
          envelope('session.status', {
            sessionID: 'session_other',
            status: { type: 'busy' }
          })
        ])
      }))
    )

    service.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })
    await flush()

    expect(agentHookServerMock.ingestTerminalStatus).not.toHaveBeenCalled()
  })

  it('ignores sessions whose directory is an ancestor of the pane cwd', async () => {
    writeServiceFile()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string) => ({
        ok: true,
        status: 200,
        body: sseBody([
          envelope('session.created', {
            sessionID: 'session_parent',
            location: { directory: '/' }
          }),
          envelope('session.status', {
            sessionID: 'session_parent',
            status: { type: 'busy' }
          })
        ])
      }))
    )

    service.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })
    await flush()

    expect(agentHookServerMock.ingestTerminalStatus).not.toHaveBeenCalled()
  })

  it('attributes sessions launched from a worktree subdirectory', async () => {
    writeServiceFile()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string) => ({
        ok: true,
        status: 200,
        body: sseBody([
          envelope('session.created', {
            sessionID: 'session_sub',
            location: { directory: '/repo/pkg' }
          }),
          envelope('session.status', {
            sessionID: 'session_sub',
            status: { type: 'busy' }
          })
        ])
      }))
    )

    service.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })
    await flush()

    // Why: session.created carries attribution only — the status event is the
    // first ingest.
    expect(agentHookServerMock.ingestTerminalStatus).toHaveBeenCalledTimes(1)
  })

  it('throttles text deltas but always ingests the final text', async () => {
    writeServiceFile()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string) => ({
        ok: true,
        status: 200,
        body: sseBody([
          envelope('session.created', {
            sessionID: 'session_1',
            location: { directory: '/repo' }
          }),
          envelope('session.text.delta', {
            sessionID: 'session_1',
            assistantMessageID: 'msg_1',
            delta: 'Hello '
          }),
          envelope('session.text.delta', {
            sessionID: 'session_1',
            assistantMessageID: 'msg_1',
            delta: 'world'
          }),
          envelope('session.text.ended', {
            sessionID: 'session_1',
            assistantMessageID: 'msg_1',
            text: 'Hello world'
          })
        ])
      }))
    )

    service.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })

    // Why: the stream settles asynchronously; poll for the final text instead
    // of relying on a fixed tick count.
    await vi.waitFor(() => {
      const texts = agentHookServerMock.ingestTerminalStatus.mock.calls.map(
        (call) => call[0].payload.lastAssistantMessage
      )
      expect(texts.at(-1)).toBe('Hello world')
    })
  })

  it('forwards inferred interrupts to the service API', async () => {
    writeServiceFile()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: null }))
    vi.stubGlobal('fetch', fetchMock)

    service.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })
    expect(agentHookServerMock.onInterruptInferred).not.toBeNull()

    agentHookServerMock.onInterruptInferred!({
      paneKey: 'tab_1:leaf_1',
      agentType: 'opencode2',
      providerSession: { key: 'session_id', id: 'session_1' }
    })
    await flush()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4096/api/session/session_1/interrupt',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('does not forward interrupts for other agent types', async () => {
    writeServiceFile()
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: null }))
    vi.stubGlobal('fetch', fetchMock)

    service.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })
    agentHookServerMock.onInterruptInferred!({
      paneKey: 'tab_1:leaf_1',
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'session_1' }
    })
    await flush()

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/interrupt'),
      expect.anything()
    )
  })
})
