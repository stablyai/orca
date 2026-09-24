import { describe, expect, it, vi } from 'vitest'
import type { ClangdSession, openClangdSession } from './clangd-session'
import { createLanguageServerHost, type LanguageServerHost } from './language-server-host'
import type { LanguageServerDocumentChange } from '../../shared/language-server-navigation-types'

type SessionStub = {
  session: ClangdSession
  startCalls: { program: string; rootPath: string }[]
}

function stubSession(overrides: Partial<ClangdSession> = {}): SessionStub {
  const startCalls: { program: string; rootPath: string }[] = []
  let version = 1
  const session = {
    serverVersion: '23.1.0-test',
    rootPath: '',
    died: null,
    hasDocument: () => true,
    didOpen: () => {
      version = 1
    },
    didChange: (_filePath: string, requestedVersion: number) => {
      version = Math.max(version + 1, requestedVersion)
      return version
    },
    didClose: () => {},
    definition: vi.fn(async () => []),
    hover: vi.fn(async () => null),
    stop: vi.fn(async () => {}),
    ...overrides
  } as unknown as ClangdSession
  return { session, startCalls }
}

function hostFrom(stub: SessionStub): LanguageServerHost {
  return createLanguageServerHost({}, (async (options) => {
    stub.startCalls.push({ program: options.program, rootPath: options.rootPath })
    return stub.session
  }) as unknown as typeof openClangdSession)
}

const CHANGE: LanguageServerDocumentChange = {
  range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
  text: 'x'
}

describe('createLanguageServerHost', () => {
  it('starts one session per worktree root and routes documents to it', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({
      worktreeRoot: 'd:\\proj-a',
      filePath: 'D:\\proj-a\\src\\main.cpp',
      text: 'x'
    })
    await host.openDocument({
      worktreeRoot: 'D:\\proj-a',
      filePath: 'D:/proj-a/src/util.cpp',
      text: 'y'
    })
    expect(stub.startCalls).toHaveLength(1)
    expect(stub.startCalls[0]?.rootPath).toBe('D:\\proj-a')
    expect(host.sessionCount).toBe(1)

    // Same-path canonicalization across separator/case spellings routes home.
    expect(
      host.changeDocument({ filePath: 'd:/proj-a/src/main.cpp', version: 2, changes: [CHANGE] }).ok
    ).toBe(true)
    const definition = await host.definition({
      filePath: 'D:/proj-a/src/util.cpp',
      position: { line: 0, character: 0 }
    })
    expect(definition).toEqual([])

    expect(host.closeDocument({ filePath: 'D:\\proj-a\\src\\main.cpp' }).ok).toBe(true)
  })

  it('starts a second session for a different worktree root', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({
      worktreeRoot: 'D:\\proj-a',
      filePath: 'D:\\proj-a\\a.cpp',
      text: 'x'
    })
    await host.openDocument({
      worktreeRoot: 'D:\\proj-b',
      filePath: 'D:\\proj-b\\b.cpp',
      text: 'y'
    })
    expect(stub.startCalls.map((call) => call.rootPath)).toEqual(['D:\\proj-a', 'D:\\proj-b'])
    expect(host.sessionCount).toBe(2)
  })

  it('fails closed for changes/requests on documents with no session', () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    const result = host.changeDocument({
      filePath: 'D:\\nowhere\\x.cpp',
      version: 1,
      changes: [CHANGE]
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('no language-server session')
  })

  it('forwards status events from the session', async () => {
    const statuses: (string | null)[] = []
    const statusEmitter: { emit: ((text: string | null) => void) | null } = { emit: null }
    const stub = stubSession()
    const host = createLanguageServerHost({ onStatus: (text) => statuses.push(text) }, (async (
      options
    ) => {
      statusEmitter.emit = options.onStatus ?? null
      return stub.session
    }) as unknown as typeof openClangdSession)
    await host.openDocument({ worktreeRoot: 'D:\\p', filePath: 'D:\\p\\a.cpp', text: 'x' })
    statusEmitter.emit?.('clangd: indexing 10%')
    statusEmitter.emit?.(null)
    expect(statuses).toEqual(['clangd: indexing 10%', null])
  })

  it('shutdownAll stops every session once', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({
      worktreeRoot: 'D:\\proj-a',
      filePath: 'D:\\proj-a\\a.cpp',
      text: 'x'
    })
    await host.shutdownAll()
    expect(stub.session.stop).toHaveBeenCalledTimes(1)
    expect(host.sessionCount).toBe(0)
  })

  it('reports a failed session start as ok:false instead of throwing', async () => {
    const host = createLanguageServerHost({}, (async () => {
      throw new Error('clangd not found')
    }) as unknown as typeof openClangdSession)
    const result = await host.openDocument({
      worktreeRoot: 'D:\\p',
      filePath: 'D:\\p\\a.cpp',
      text: 'x'
    })
    expect(result).toEqual({ ok: false, error: 'clangd not found' })
    expect(host.sessionCount).toBe(0)
    // A later open retries the start instead of caching the failure forever.
    expect(
      host.changeDocument({ filePath: 'D:\\p\\a.cpp', version: 2, changes: [CHANGE] }).ok
    ).toBe(false)
  })

  it('routes external documents through the session that opened them', async () => {
    const stub = stubSession()
    const host = hostFrom(stub)
    await host.openDocument({
      worktreeRoot: 'D:\\proj',
      filePath: 'C:\\Program Files\\STL\\chrono',
      text: 'x'
    })
    expect(
      host.changeDocument({
        filePath: 'c:/Program Files/STL/chrono',
        version: 2,
        changes: [CHANGE]
      }).ok
    ).toBe(true)
  })
})
