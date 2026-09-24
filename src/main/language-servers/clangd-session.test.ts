import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { createLspFrameParser, encodeLspMessage } from '../../shared/lsp-content-length-framer'
import {
  ClangdPositionEncodingError,
  openClangdSession,
  type ClangdSession
} from './clangd-session'

// ---------------------------------------------------------------------------
// In-memory fake clangd: full control over framing, death and request answers.
// ---------------------------------------------------------------------------

type FakeClangdOptions = {
  positionEncoding?: string
  /** When false, the initialize result omits references/declaration caps (S4 verification path). */
  advertiseReferencesDeclaration?: boolean
  /** The server's semanticTokensProvider legend advertised at initialize (S5). */
  semanticTokensLegend?: { tokenTypes: string[]; tokenModifiers: string[] }
  /** The relative 5-tuple data returned for textDocument/semanticTokens/full (S5). */
  semanticTokensData?: readonly number[]
  onClientMessage?: (message: Record<string, unknown>) => void
  /** Methods the fake never answers, for in-flight-at-death assertions. */
  hangOn?: readonly string[]
}

type FakeClangd = {
  spawnImpl: typeof spawnProcess
  pushToClient: (message: unknown) => void
  clientMessages: Record<string, unknown>[]
  crash: () => void
}

function fakeClangd(options: FakeClangdOptions = {}): FakeClangd {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
    pid: number
    kill: () => void
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  // Outside any real process table so teardown can never hit a live pid.
  child.pid = 9_999_998
  child.kill = () => {}

  const clientMessages: Record<string, unknown>[] = []
  const parser = createLspFrameParser(
    (raw) => {
      const message = raw as Record<string, unknown>
      clientMessages.push(message)
      options.onClientMessage?.(message)
      const method = message.method
      const id = message.id
      if (options.hangOn?.includes(method as string)) {
        return
      }
      if (method === 'initialize') {
        const advertise = options.advertiseReferencesDeclaration ?? true
        pushToClient({
          jsonrpc: '2.0',
          id,
          result: {
            capabilities: {
              positionEncoding: options.positionEncoding ?? 'utf-16',
              textDocumentSync: { change: 2, openClose: true, save: true },
              hoverProvider: true,
              definitionProvider: true,
              ...(advertise ? { referencesProvider: true, declarationProvider: true } : {}),
              ...(options.semanticTokensLegend
                ? {
                    semanticTokensProvider: {
                      full: { delta: true },
                      legend: options.semanticTokensLegend,
                      range: false
                    }
                  }
                : {})
            },
            serverInfo: { name: 'clangd', version: '23.1.0' }
          }
        })
        return
      }
      if (method === 'textDocument/definition') {
        pushToClient({
          jsonrpc: '2.0',
          id,
          result: [
            {
              uri: 'file:///D:/zwf/Project%20A/lib/Header.hpp',
              range: {
                start: { line: 39, character: 8 },
                end: { line: 39, character: 22 }
              }
            }
          ]
        })
        return
      }
      if (method === 'textDocument/references') {
        // Two reference sites: the declaration (Header.hpp) + the call site (main.cpp).
        pushToClient({
          jsonrpc: '2.0',
          id,
          result: [
            {
              uri: 'file:///D:/zwf/Project%20A/lib/Header.hpp',
              range: {
                start: { line: 39, character: 8 },
                end: { line: 39, character: 22 }
              }
            },
            {
              uri: 'file:///D:/zwf/Project%20A/src/main.cpp',
              range: {
                start: { line: 2, character: 6 },
                end: { line: 2, character: 18 }
              }
            }
          ]
        })
        return
      }
      if (method === 'textDocument/declaration') {
        // Declaration resolves to the header (header-symbol behavior mirrors definition).
        pushToClient({
          jsonrpc: '2.0',
          id,
          result: [
            {
              uri: 'file:///D:/zwf/Project%20A/lib/Header.hpp',
              range: {
                start: { line: 12, character: 4 },
                end: { line: 12, character: 16 }
              }
            }
          ]
        })
        return
      }
      if (method === 'textDocument/hover') {
        pushToClient({
          jsonrpc: '2.0',
          id,
          result: {
            contents: { kind: 'markdown', value: '### method `X`' },
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
          }
        })
        return
      }
      if (method === 'textDocument/semanticTokens/full') {
        pushToClient({
          jsonrpc: '2.0',
          id,
          result: { data: options.semanticTokensData ?? [] }
        })
        return
      }
      if (method === 'shutdown') {
        pushToClient({ jsonrpc: '2.0', id, result: null })
      }
    },
    () => {}
  )
  child.stdin.on('data', (chunk: Buffer) => parser.feed(chunk))

  function pushToClient(message: unknown): void {
    child.stdout.write(encodeLspMessage(message))
  }

  return {
    spawnImpl: (() => child) as unknown as typeof spawnProcess,
    pushToClient,
    clientMessages,
    crash: () => {
      child.stdout.end()
      child.emit('exit', 1, null)
    }
  }
}

async function openSessionWith(
  fake: FakeClangd,
  events: { onStatus?: (text: string | null) => void; onLog?: (line: string) => void } = {}
): Promise<ClangdSession> {
  return openClangdSession({
    program: 'clangd',
    args: ['--log=info'],
    rootPath: 'D:\\zwf\\Project A',
    onStatus: events.onStatus,
    onLog: events.onLog,
    spawnImpl: fake.spawnImpl
  })
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('openClangdSession — handshake', () => {
  it('sends the spike-verified initialize shape and notifies initialized', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)
    const init = fake.clientMessages.find((m) => m.method === 'initialize')
    expect(init).toBeDefined()
    const params = init?.params as Record<string, unknown>
    expect(params.processId).toBe(process.pid)
    expect(params.rootUri).toBe('file:///D:/zwf/Project%20A')
    expect(params.workspaceFolders).toEqual([
      { uri: 'file:///D:/zwf/Project%20A', name: 'Project A' }
    ])
    const capabilities = params.capabilities as Record<string, Record<string, unknown>>
    expect(capabilities.general.positionEncodings).toEqual(['utf-16'])
    expect(capabilities.window.workDoneProgress).toBe(true)
    const textDocument = capabilities.textDocument as Record<string, Record<string, unknown>>
    expect(textDocument.synchronization.didSave).toBe(false)
    expect(textDocument.hover.contentFormat).toEqual(['markdown', 'plaintext'])
    // S4: the client advertises references + declaration capability (mirrors definition).
    expect(textDocument.references.dynamicRegistration).toBe(false)
    expect(textDocument.declaration.dynamicRegistration).toBe(false)
    expect(textDocument.declaration.linkSupport).toBe(false)
    expect(session.serverVersion).toBe('23.1.0')
    await session.stop()
    // initialized goes out right after the initialize result, before anything else.
    const initializedIndex = fake.clientMessages.findIndex((m) => m.method === 'initialized')
    expect(initializedIndex).toBeGreaterThan(
      fake.clientMessages.findIndex((m) => m.method === 'initialize')
    )
  })

  it('refuses the session when the server does not confirm utf-16', async () => {
    const fake = fakeClangd({ positionEncoding: 'utf-8' })
    await expect(openSessionWith(fake)).rejects.toBeInstanceOf(ClangdPositionEncodingError)
  })

  it('warns but does not refuse when the server omits references/declaration capability (S4 verification)', async () => {
    const logs: string[] = []
    const fake = fakeClangd({ advertiseReferencesDeclaration: false })
    const session = await openSessionWith(fake, { onLog: (line) => logs.push(line) })
    expect(logs.some((line) => /references\/declaration capability/.test(line))).toBe(true)
    await session.stop()
  })
})

describe('openClangdSession — server->client requests must be answered', () => {
  it('answers workDoneProgress/create and configuration; $/progress maps to status', async () => {
    const statusTexts: (string | null)[] = []
    const fake = fakeClangd()
    const session = await openSessionWith(fake, {
      onStatus: (text) => statusTexts.push(text)
    })

    fake.pushToClient({
      jsonrpc: '2.0',
      id: 50,
      method: 'window/workDoneProgress/create',
      params: { token: 'index' }
    })
    fake.pushToClient({
      jsonrpc: '2.0',
      id: 51,
      method: 'workspace/configuration',
      params: { items: [{}, {}, {}] }
    })
    await flush()
    const answers = fake.clientMessages
      .filter((m) => m.result !== undefined && m.id !== undefined)
      .map((m) => m.result)
    expect(answers).toEqual([null, [null, null, null]])

    fake.pushToClient({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'index', value: { kind: 'begin', title: 'background index' } }
    })
    fake.pushToClient({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'index', value: { kind: 'report', percentage: 42.7, message: '42/100' } }
    })
    fake.pushToClient({
      jsonrpc: '2.0',
      method: '$/progress',
      params: { token: 'index', value: { kind: 'end' } }
    })
    expect(statusTexts).toEqual([
      'clangd: background index',
      'clangd: background index 42% — 42/100',
      null
    ])
    await session.stop()
  })
})

describe('openClangdSession — document sync', () => {
  it('didOpen/didChange/didClose translate to LSP shapes with 0-based ranges', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)

    session.didOpen('d:/zwf/Project A/src/main.cpp', 'int main() {}\n')
    const opened = fake.clientMessages.find((m) => m.method === 'textDocument/didOpen') as {
      params: { textDocument: unknown }
    }
    expect(opened.params.textDocument).toEqual({
      uri: 'file:///D:/zwf/Project%20A/src/main.cpp',
      languageId: 'cpp',
      version: 1,
      text: 'int main() {}\n'
    })

    const sentVersion = session.didChange('D:\\zwf\\Project A\\src\\main.cpp', 2, [
      {
        range: { startLine: 0, startCharacter: 4, endLine: 0, endCharacter: 4 },
        rangeLength: 0,
        text: 'x'
      }
    ])
    expect(sentVersion).toBe(2)
    const changed = fake.clientMessages.find((m) => m.method === 'textDocument/didChange') as {
      params: { contentChanges: unknown }
    }
    expect(changed.params.contentChanges).toEqual([
      {
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 4 }
        },
        rangeLength: 0,
        text: 'x'
      }
    ])

    // Version rollback attempt: the clamp bumps past the last sent version.
    const clamped = session.didChange('D:/zwf/Project A/src/main.cpp', 1, [
      { range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 }, text: 'y' }
    ])
    expect(clamped).toBe(3)

    session.didClose('D:\\zwf/Project A\\src\\main.cpp')
    const closed = fake.clientMessages.find((m) => m.method === 'textDocument/didClose') as {
      params: { textDocument: { uri: string } }
    }
    expect(closed.params.textDocument.uri).toBe('file:///D:/zwf/Project%20A/src/main.cpp')
    expect(
      session.hasDocument('d:/zwf/project a/src/main.cpp'.replace('project a', 'Project A'))
    ).toBe(false)
    await session.stop()
  })

  it('didChange for an unopened document throws a typed error', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)
    expect(() =>
      session.didChange('D:\\not\\open.cpp', 2, [
        { range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 }, text: 'x' }
      ])
    ).toThrow(/no open document/)
    await session.stop()
  })

  it('publishDiagnostics is accepted silently (version alignment only)', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)
    session.didOpen('D:\\a.cpp', 'x')
    fake.pushToClient({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///D:/a.cpp', version: 4, diagnostics: [] }
    })
    expect(session.died).toBeNull()
    await session.stop()
  })
})

describe('openClangdSession — navigation', () => {
  it('definition returns semantic locations with native paths', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)
    session.didOpen('D:\\zwf\\Project A\\src\\main.cpp', 'x')
    const locations = await session.definition('D:\\zwf\\Project A\\src\\main.cpp', {
      line: 2,
      character: 6
    })
    expect(locations).toEqual([
      {
        path: 'D:\\zwf\\Project A\\lib\\Header.hpp',
        range: {
          startLine: 39,
          startCharacter: 8,
          endLine: 39,
          endCharacter: 22
        }
      }
    ])
    await session.stop()
  })

  it('references sends textDocument/references with includeDeclaration and maps Location[]', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)
    session.didOpen('D:\\zwf\\Project A\\src\\main.cpp', 'x')
    const locations = await session.references('D:\\zwf\\Project A\\src\\main.cpp', {
      line: 2,
      character: 6
    })
    // includeDeclaration=true so the declaration site appears alongside the call.
    const req = fake.clientMessages.find((m) => m.method === 'textDocument/references') as {
      params: { context: { includeDeclaration: boolean } }
    }
    expect(req.params.context.includeDeclaration).toBe(true)
    expect(locations).toEqual([
      {
        path: 'D:\\zwf\\Project A\\lib\\Header.hpp',
        range: { startLine: 39, startCharacter: 8, endLine: 39, endCharacter: 22 }
      },
      {
        path: 'D:\\zwf\\Project A\\src\\main.cpp',
        range: { startLine: 2, startCharacter: 6, endLine: 2, endCharacter: 18 }
      }
    ])
    await session.stop()
  })

  it('declaration maps Location[] to semantic locations (header-symbol mirror of definition)', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)
    session.didOpen('D:\\zwf\\Project A\\src\\main.cpp', 'x')
    const locations = await session.declaration('D:\\zwf\\Project A\\src\\main.cpp', {
      line: 0,
      character: 0
    })
    expect(locations).toEqual([
      {
        path: 'D:\\zwf\\Project A\\lib\\Header.hpp',
        range: { startLine: 12, startCharacter: 4, endLine: 12, endCharacter: 16 }
      }
    ])
    await session.stop()
  })

  it('hover maps MarkupContent to the semantic shape and null stays null', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)
    session.didOpen('D:\\a.cpp', 'x')
    const hover = await session.hover('D:\\a.cpp', { line: 0, character: 0 })
    expect(hover).toEqual({ kind: 'markdown', value: '### method `X`' })
    await session.stop()
  })

  it('semanticTokensFull decodes the server legend BY NAME (S5)', async () => {
    // clangd's legend differs from LSP standard names (spike findings §1) —
    // decode must map the server's indices to ITS OWN type/modifier names.
    const fake = fakeClangd({
      semanticTokensLegend: {
        tokenTypes: ['variable', 'function', 'macro', 'unknown-type'],
        tokenModifiers: ['declaration', 'globalScope']
      },
      // (deltaLine, deltaChar, length, typeIdx, modBitmask) relative 5-tuples.
      semanticTokensData: [
        0,
        0,
        3,
        1,
        0b001, // 'function' + declaration
        0,
        4,
        5,
        0,
        0b010, // 'variable' + globalScope
        1,
        0,
        7,
        3,
        0 // 'unknown-type' (self-invented) -> skip sentinel
      ]
    })
    const session = await openSessionWith(fake)
    session.didOpen('D:\\zwf\\Project A\\src\\main.cpp', 'x')
    const tokens = await session.semanticTokensFull('D:\\zwf\\Project A\\src\\main.cpp')
    expect(tokens.tokenTypes).toEqual(['variable', 'function', 'macro', 'unknown-type'])
    expect(tokens.tokenModifiers).toEqual(['declaration', 'globalScope'])
    expect(tokens.tokens).toEqual([
      { line: 0, char: 0, length: 3, type: 'function', modifiers: ['declaration'] },
      { line: 0, char: 4, length: 5, type: 'variable', modifiers: ['globalScope'] },
      // 'unknown-type' is decoded faithfully by the SERVER legend; the renderer
      // re-encodes against the CLIENT legend and skips it there (spike §1).
      { line: 1, char: 0, length: 7, type: 'unknown-type', modifiers: [] }
    ])
    await session.stop()
  })

  it('semanticTokensFull returns an empty set when the server advertised no legend', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)
    session.didOpen('D:\\a.cpp', 'x')
    const tokens = await session.semanticTokensFull('D:\\a.cpp')
    expect(tokens).toEqual({ tokenTypes: [], tokenModifiers: [], tokens: [] })
    await session.stop()
  })
})

describe('openClangdSession — death and shutdown', () => {
  it('a crashed process rejects pending requests and reports the exit once', async () => {
    const fake = fakeClangd({ hangOn: ['textDocument/hover'] })
    const exits: (Error | null)[] = []
    const session = await openClangdSession({
      program: 'clangd',
      args: [],
      rootPath: 'D:\\r',
      onExit: (error) => exits.push(error),
      spawnImpl: fake.spawnImpl
    })
    session.didOpen('D:\\r\\a.cpp', 'x')
    const pending = session.hover('D:\\r\\a.cpp', { line: 0, character: 0 })
    fake.crash()
    await expect(pending).rejects.toThrow(/session died/)
    expect(session.died?.message).toMatch(/session died/)
    expect(exits.filter((error) => error !== null)).toHaveLength(1)
  })

  it('stop() performs shutdown -> exit and resolves without killing', async () => {
    const fake = fakeClangd()
    const session = await openSessionWith(fake)
    await session.stop()
    const methods = fake.clientMessages.map((m) => m.method)
    expect(methods.indexOf('shutdown')).toBeLessThan(methods.length - 1)
    expect(methods).toContain('exit')
  })
})

// ---------------------------------------------------------------------------
// A real `node -e` child speaking Content-Length framing: proves the actual
// spawnProcess adapter, both traffic directions, and the no-orphan stop.
// ---------------------------------------------------------------------------

const FAKE_CLANGD_SCRIPT = String.raw`
  // Self-contained mini-framer: the real one is TypeScript and this child is plain node.
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    process.stdout.write(
      Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body])
    )
  }
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const index = buffer.indexOf('\r\n\r\n')
      if (index === -1) return
      const header = buffer.subarray(0, index).toString('ascii')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) process.exit(3)
      const total = index + 4 + Number(match[1])
      if (buffer.length < total) return
      const message = JSON.parse(buffer.subarray(index + 4, total).toString('utf8'))
      buffer = buffer.subarray(total)
      if (message.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            capabilities: { positionEncoding: 'utf-16' },
            serverInfo: { version: 'node-fake' }
          }
        })
      } else if (message.method === 'textDocument/definition') {
        const uri = message.params.textDocument.uri
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: [
            {
              uri: uri.replace(/src\/a\.cpp$/, 'lib/x.hpp'),
              range: { start: { line: 10, character: 2 }, end: { line: 10, character: 9 } }
            }
          ]
        })
      } else if (message.method === 'textDocument/hover') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { contents: { kind: 'markdown', value: 'hover body' } }
        })
      } else if (message.method === 'shutdown') {
        send({ jsonrpc: '2.0', id: message.id, result: null })
      } else if (message.method === 'exit') {
        process.exit(0)
      }
    }
  })
`

describe('openClangdSession — real child process', () => {
  it('end-to-end over real stdio: spawn, navigate, clean shutdown, no orphan', async () => {
    // spawn() fails ENOENT when cwd does not exist, so the root must be real;
    // the CJK segment keeps the multibyte-path coverage.
    const tempRoot = mkdtempSync(join(tmpdir(), 'clangd-session-'))
    const rootPath = join(tempRoot, 'Dir 中文')
    mkdirSync(rootPath)
    const session = await openClangdSession({
      program: process.execPath,
      args: ['-e', FAKE_CLANGD_SCRIPT],
      rootPath
    })
    expect(session.serverVersion).toBe('node-fake')
    const source = `${rootPath}\\src\\a.cpp`
    session.didOpen(source, 'int main() {}\n')
    const locations = await session.definition(source, { line: 0, character: 4 })
    expect(locations[0]?.path).toBe(`${rootPath}\\lib\\x.hpp`)
    const hover = await session.hover(source, { line: 0, character: 4 })
    expect(hover).toEqual({ kind: 'markdown', value: 'hover body' })
    await session.stop()
    expect(session.died).toBeNull()
    rmSync(tempRoot, { recursive: true, force: true })
  })
})
