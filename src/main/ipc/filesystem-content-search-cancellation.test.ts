import { isAbsolute } from 'node:path'
import { spawnProcess } from '../../shared/child-process/run-process'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BundledRipgrepPath from '../ripgrep/bundled-ripgrep-path'

const {
  handleMock,
  resolveAuthorizedPathMock,
  bundledRipgrepCommandMock,
  getLocalGitOptionsForRegisteredWorktreeMock,
  wslAwareSpawnMock,
  parseWslPathMock,
  toWindowsWslPathMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  bundledRipgrepCommandMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn(),
  wslAwareSpawnMock: vi.fn(),
  parseWslPathMock: vi.fn((_value: string): { distro: string } | null => null),
  toWindowsWslPathMock: vi.fn((value: string) => value)
}))

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  shell: {
    trashItem: vi.fn()
  }
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(),
  wslAwareSpawn: wslAwareSpawnMock
}))

vi.mock('../wsl', () => ({
  parseWslPath: parseWslPathMock,
  toWindowsWslPath: toWindowsWslPathMock
}))

vi.mock('./filesystem-auth', () => ({
  authorizeExternalPath: vi.fn(async (value: string) => value),
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('./local-file-access-resolution', () => ({
  resolveDesktopAuthorizedPath: resolveAuthorizedPathMock,
  resolveLocalFileRequestPath: resolveAuthorizedPathMock
}))

vi.mock('./filesystem-path-containment', () => ({
  isENOENT: vi.fn(() => false),
  validateGitRelativeFilePath: vi.fn((value: string) => value)
}))

vi.mock('./registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: vi.fn(async (value: string) => value)
}))

vi.mock('./filesystem-list-files', () => ({
  listQuickOpenFiles: vi.fn()
}))

vi.mock('./filesystem-mutations', () => ({
  registerFilesystemMutationHandlers: vi.fn()
}))

vi.mock('../ripgrep/bundled-ripgrep-path', async (importOriginal) => ({
  ...(await importOriginal<typeof BundledRipgrepPath>()),
  bundledRipgrepCommand: bundledRipgrepCommandMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

vi.mock('./markdown-documents', () => ({
  listMarkdownDocuments: vi.fn(),
  markdownDocumentsFromRelativePaths: vi.fn()
}))

import { registerFilesystemHandlers } from './filesystem'

function createMockProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: new EventEmitter(),
    kill: vi.fn()
  })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}

describe('content search cancellation', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })
    resolveAuthorizedPathMock.mockImplementation(async (value: string) => value)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
    parseWslPathMock.mockReturnValue(null)
    bundledRipgrepCommandMock.mockImplementation((options?: { wsl?: boolean }) =>
      options?.wsl ? '/bundled/linux/rg' : '/bundled/rg'
    )
  })

  it('cancels only the issuing window before authorization completes', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all store access is mocked for these handlers.
    registerFilesystemHandlers({} as never)
    const sender = Object.assign(new EventEmitter(), { id: 7 })
    const otherSender = Object.assign(new EventEmitter(), { id: 8 })
    let authorize: ((path: string) => void) | undefined
    resolveAuthorizedPathMock.mockReturnValue(
      new Promise<string>((resolve) => {
        authorize = resolve
      })
    )
    const pending = handlers.get('fs:search')!(
      { sender },
      { rootPath: '/repo', query: 'needle', requestToken: 'owned' }
    )
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    handlers.get('fs:cancelSearch')!({ sender: otherSender }, { requestToken: 'owned' })
    handlers.get('fs:cancelSearch')!({ sender }, { requestToken: 'owned' })
    authorize?.('/repo')
    await rejection
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
    expect(sender.eventNames()).toHaveLength(0)
  })

  it('settles aborted searches even when kill emits close synchronously, and preserves the replacement', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all store access is mocked for these handlers.
    registerFilesystemHandlers({} as never)
    const sender = Object.assign(new EventEmitter(), { id: 7 })
    const oldChild = createMockProcess()
    const latestChild = createMockProcess()
    vi.mocked(oldChild.kill).mockImplementation(() => {
      oldChild.emit('close', null, 'SIGTERM')
      return true
    })
    wslAwareSpawnMock.mockReturnValueOnce(oldChild).mockReturnValueOnce(latestChild)
    const first = handlers.get('fs:search')!(
      { sender },
      { rootPath: '/repo', query: 'old', requestToken: 'same' }
    )
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await flushMicrotasks()
    const latest = handlers.get('fs:search')!(
      { sender },
      { rootPath: '/repo', query: 'latest', requestToken: 'same' }
    )
    await flushMicrotasks()
    await firstRejected
    expect(oldChild.kill).toHaveBeenCalledOnce()
    expect(latestChild.kill).not.toHaveBeenCalled()
    latestChild.emit('close', 1, null)
    await expect(latest).resolves.toMatchObject({ totalMatches: 0, truncated: false })
    expect(sender.eventNames()).toHaveLength(0)
  })

  it('keeps lexical workspace result paths while executing inside its authorized canonical root', async () => {
    registerFilesystemHandlers(Object.create(null))
    const sender = Object.assign(new EventEmitter(), { id: 7 })
    const child = createMockProcess()
    resolveAuthorizedPathMock.mockResolvedValue('/private/tmp/workspace')
    wslAwareSpawnMock.mockReturnValue(child)
    const result = handlers.get('fs:search')!(
      { sender },
      { rootPath: '/tmp/workspace', query: 'needle' }
    )
    await flushMicrotasks()
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        type: 'match',
        data: {
          path: { text: './example.txt' },
          lines: { text: 'needle\n' },
          line_number: 1,
          submatches: [{ match: { text: 'needle' }, start: 0, end: 6 }]
        }
      })}\n`
    )
    child.emit('close', 0, null)
    await expect(result).resolves.toMatchObject({
      files: [{ filePath: '/tmp/workspace/example.txt', relativePath: 'example.txt' }]
    })
    expect(wslAwareSpawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/private/tmp/workspace' })
    )
  })

  it('kills a real local search fixture when its renderer abandons the request', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization and store access are mocked; the process is real.
    registerFilesystemHandlers({} as never)
    const sender = Object.assign(new EventEmitter(), { id: 7 })
    const binary = await vi.importActual<typeof BundledRipgrepPath>(
      '../ripgrep/bundled-ripgrep-path'
    )
    const program = binary.bundledRipgrepCommand()
    expect(isAbsolute(program)).toBe(true)
    const child = spawnProcess({ program, args: ['--json', '--line-buffered', 'needle', '-'] })
    const exited = new Promise((resolve) => child.once('close', resolve))
    wslAwareSpawnMock.mockReturnValueOnce(child)
    const pending = handlers.get('fs:search')!(
      { sender },
      { rootPath: '/repo', query: 'fixture', requestToken: 'real' }
    )
    const outcome = Promise.resolve(pending).then(
      () => null,
      (error: unknown) => error
    )
    try {
      const output = new Promise((resolve, reject) => {
        child.stdout.once('data', resolve)
        child.once('error', reject)
      })
      child.stdin.write(`needle\n${'x'.repeat(65_536)}\n`)
      await output
      handlers.get('fs:cancelSearch')!({ sender }, { requestToken: 'real' })
      expect(await outcome).toMatchObject({ name: 'AbortError' })
      await exited
      expect(child.signalCode).toBe('SIGTERM')
      expect(sender.eventNames()).toHaveLength(0)
    } finally {
      child.kill()
    }
  })
  it('leaves no live local processes after abandoning scans in six workspace roots', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization and store access are mocked; subprocesses are real.
    registerFilesystemHandlers({} as never)
    const sender = Object.assign(new EventEmitter(), { id: 7 })
    const children: ReturnType<typeof spawnProcess>[] = []
    const exits: Promise<unknown>[] = []
    for (let index = 0; index < 6; index++) {
      const child = spawnProcess({
        program: process.execPath,
        args: ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)']
      })
      children.push(child)
      exits.push(new Promise((resolve) => child.once('close', resolve)))
      wslAwareSpawnMock.mockReturnValueOnce(child)
      const request = handlers.get('fs:search')!(
        { sender },
        { rootPath: `/repo-${index}`, query: 'fixture', requestToken: `real-${index}` }
      )
      if (request instanceof Promise) {
        void request.catch(() => undefined)
      }
      await new Promise((resolve) => child.stdout.once('data', resolve))
    }
    const live = () =>
      children.filter((child) => child.exitCode === null && child.signalCode === null).length
    const before = live()
    const started = performance.now()
    try {
      for (let index = 0; index < 6; index++) {
        handlers.get('fs:cancelSearch')?.({ sender }, { requestToken: `real-${index}` })
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
      const after = live()
      console.info(
        JSON.stringify({
          processCountBeforeClear: before,
          processCountAfterClear: after,
          observedAfterMs: Math.round(performance.now() - started)
        })
      )
      expect(before).toBe(6)
      expect(after).toBe(0)
    } finally {
      for (const child of children) {
        child.kill()
      }
      await Promise.all(exits)
    }
  })
})
