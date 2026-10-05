import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import { LspSession, type LspPort, type LspSessionConfig } from './lsp-session'

const FAKE_SERVER = fileURLToPath(
  new URL('./__fixtures__/fake-language-server.mjs', import.meta.url)
)

function fakePort() {
  const sent: unknown[] = []
  let messageListener: (data: unknown) => void = () => {}
  let closeListener: () => void = () => {}
  const port: LspPort = {
    post: (m) => sent.push(m),
    onMessage: (listener) => {
      messageListener = listener
    },
    onClose: (listener) => {
      closeListener = listener
    },
    close: vi.fn()
  }
  return { port, sent, send: (m: unknown) => messageListener(m), disconnect: () => closeListener() }
}

const sessions: LspSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose({ force: true })))
})

function startSession(overrides: Partial<LspSessionConfig> = {}) {
  const onExit = vi.fn()
  const session = new LspSession({
    serverId: 'typescript',
    rootPath: tmpdir(),
    command: { program: process.execPath, args: [FAKE_SERVER], env: process.env },
    initializationOptions: null,
    idleShutdownMs: 50,
    onExit,
    ...overrides
  })
  sessions.push(session)
  return { session, onExit }
}
const hover = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'textDocument/hover',
  params: {}
})
const didOpen = (uri: string) => ({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri, languageId: 'typescript', version: 1, text: '' } }
})

describe('LspSession', { timeout: 30_000 }, () => {
  it('queues early port messages and answers them after initialize', async () => {
    const { session } = startSession()
    const a = fakePort()
    session.attachPort(a.port)
    a.send(hover(1))
    await vi.waitFor(() => expect(a.sent).toContainEqual(expect.objectContaining({ id: 1 })), {
      timeout: 15_000
    })
    expect(a.sent).toHaveLength(1) // Why: diagnostics from the fixture must not reach the port.
    await session.dispose()
  })

  it('answers the semantic tokens legend from initialize and forwards token requests', async () => {
    const { session } = startSession()
    const a = fakePort()
    session.attachPort(a.port)
    a.send({ jsonrpc: '2.0', id: 1, method: 'orca/semanticTokensLegend' })
    a.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/semanticTokens/full',
      params: { textDocument: { uri: 'file:///a.rb' } }
    })
    await vi.waitFor(() => expect(a.sent).toHaveLength(2), { timeout: 15_000 })
    expect(a.sent).toContainEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tokenTypes: ['variable', 'method'], tokenModifiers: ['declaration'] }
    })
    expect(a.sent).toContainEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { resultId: 'r1', data: [0, 0, 3, 1, 1] }
    })
    await session.dispose()
  })

  it("closes a disconnected port's documents on the server", async () => {
    const { session } = startSession()
    const a = fakePort()
    const b = fakePort()
    session.attachPort(a.port)
    session.attachPort(b.port)
    a.send(didOpen('file:///a.ts'))
    b.send(hover(1))
    await vi.waitFor(
      () =>
        expect(b.sent).toContainEqual(
          expect.objectContaining({ result: { contents: { kind: 'markdown', value: 'open:1' } } })
        ),
      { timeout: 15_000 }
    )
    a.disconnect()
    b.send(hover(2))
    await vi.waitFor(
      () =>
        expect(b.sent).toContainEqual(
          expect.objectContaining({
            id: 2,
            result: { contents: { kind: 'markdown', value: 'open:0' } }
          })
        ),
      { timeout: 15_000 }
    )
    await session.dispose()
  })

  it('shuts down after the idle timeout once the last port closes', async () => {
    const { session, onExit } = startSession()
    const a = fakePort()
    session.attachPort(a.port)
    await session.ready
    a.disconnect()
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(false), { timeout: 15_000 })
  })

  it('reports an unexpected exit and closes its ports', async () => {
    const children: ReturnType<typeof spawnProcess>[] = []
    const { session, onExit } = startSession({
      spawn: (spec: ProcessSpec) => {
        const child = spawnProcess(spec)
        children.push(child)
        return child
      }
    })
    const a = fakePort()
    session.attachPort(a.port)
    await session.ready
    children[0]?.kill('SIGKILL')
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(true), { timeout: 15_000 })
    expect(a.port.close).toHaveBeenCalled()
  })

  it('survives repeated error events on a live child without exiting', async () => {
    const children: ReturnType<typeof spawnProcess>[] = []
    const { session, onExit } = startSession({
      spawn: (spec: ProcessSpec) => {
        const child = spawnProcess(spec)
        children.push(child)
        return child
      }
    })
    await session.ready
    const child = children[0]
    expect(() => {
      child?.emit('error', new Error('kill failed 1'))
      child?.emit('error', new Error('kill failed 2'))
    }).not.toThrow()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('drops queued messages of a port that disconnects before initialize', async () => {
    const { session } = startSession()
    const a = fakePort()
    const b = fakePort()
    session.attachPort(a.port)
    session.attachPort(b.port)
    a.send(didOpen('file:///a.ts'))
    a.disconnect()
    b.send(hover(1))
    await vi.waitFor(
      () =>
        expect(b.sent).toContainEqual(
          expect.objectContaining({
            id: 1,
            result: { contents: { kind: 'markdown', value: 'open:0' } }
          })
        ),
      { timeout: 15_000 }
    )
  })

  it('reports a failed start as an unexpected exit exactly once', async () => {
    const { session, onExit } = startSession({
      command: { program: process.execPath, args: ['-e', 'process.exit(1)'], env: process.env }
    })
    await session.ready.catch(() => undefined)
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(true), { timeout: 15_000 })
    await session.dispose()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('closes a port attached after disposal', async () => {
    const { session } = startSession()
    await session.dispose({ force: true })
    const a = fakePort()
    session.attachPort(a.port)
    expect(a.port.close).toHaveBeenCalled()
  })

  it('logs the exit code and stderr tail once when the server dies at startup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const script = "process.stderr.write('x'.repeat(10000) + 'boom-tail'); process.exit(3)"
    const { session, onExit } = startSession({
      command: { program: process.execPath, args: ['-e', script], env: process.env }
    })
    await session.ready.catch(() => undefined)
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 15_000 })
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(true), { timeout: 15_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('[lsp] typescript language server for')
    expect(message).toContain(tmpdir())
    expect(message).toContain('exited with code 3')
    expect(message).toMatch(/boom-tail$/)
    expect(message.length).toBeLessThan(4_096 + 200)
    warn.mockRestore()
  })

  it('does not log on an orderly shutdown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { session } = startSession()
    await session.ready
    await session.dispose()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('shuts down after the idle timeout when no port is ever attached', async () => {
    const { onExit } = startSession()
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(false), { timeout: 15_000 })
  })

  it('keeps a session whose port attaches before the idle timeout', async () => {
    const { session, onExit } = startSession()
    session.attachPort(fakePort().port)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(onExit).not.toHaveBeenCalled()
  })
})
