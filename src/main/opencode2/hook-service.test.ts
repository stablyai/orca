import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCode2HookService } from './hook-service'

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
let servicePath = ''

function writeServiceFile(): void {
  const stateDir = mkdtempSync(join(tmpdir(), 'orca-opencode2-hook-'))
  tempDirs.push(stateDir)
  const dir = join(stateDir, 'opencode')
  mkdirSync(dir, { recursive: true })
  servicePath = join(dir, 'service.json')
  writeFileSync(
    servicePath,
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

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
  agentHookServerMock.ingestTerminalStatus.mockClear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  openCode2HookService.clearPty('pty_1')
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

    openCode2HookService.registerTerminal({
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

    openCode2HookService.registerTerminal({
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

    openCode2HookService.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })
    await flush()

    expect(agentHookServerMock.ingestTerminalStatus).not.toHaveBeenCalled()
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

    openCode2HookService.registerTerminal({
      ptyId: 'pty_1',
      cwd: '/repo',
      paneKey: 'tab_1:leaf_1'
    })
    await flush()

    const payloads = agentHookServerMock.ingestTerminalStatus.mock.calls.map(
      (call) => call[0].payload
    )
    const assistantTexts = payloads
      .map((payload) => payload.lastAssistantMessage)
      .filter((text) => typeof text === 'string' && text.length > 0)
    expect(assistantTexts.length).toBeLessThanOrEqual(2)
    expect(assistantTexts.at(-1)).toBe('Hello world')
  })
})
