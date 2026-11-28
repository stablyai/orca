import type * as WorkerThreadChildProcessModule from '../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildRequest } from '../worker-thread-child-process/worker-thread-child-process-protocol'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { workerSpawn, wslAwareSpawnMock } = vi.hoisted(() => ({
  workerSpawn: vi.fn(),
  wslAwareSpawnMock: vi.fn()
}))

vi.mock('../worker-thread-child-process/worker-thread-child-process', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkerThreadChildProcessModule>()),
  spawnProcessOnWorkerThread: workerSpawn,
  canSpawnOnWorkerThread: () => true
}))
vi.mock('../git/command-runner/host-routing/wsl-aware-spawn', () => ({
  wslAwareSpawn: wslAwareSpawnMock
}))
vi.mock('./bundled-ripgrep-path', () => ({
  bundledRipgrepCommand: () => 'C:\\orca\\rg.exe',
  bundledRipgrepWslSpawnOptions: () => ({})
}))

import { WorkerThreadChildProcess } from '../worker-thread-child-process/worker-thread-child-process'
import { listMarkdownDocuments } from '../ipc/filesystem/search/markdown-documents'
import {
  isRipgrepUnavailableExit,
  killSpawnedRipgrepProcess
} from '../../shared/ripgrep/ripgrep-process-availability'
import {
  createWorkerThreadChildProcessTestEntry,
  createWorkerThreadChildProcessTestHost
} from '../worker-thread-child-process/worker-thread-child-process-worker.test-fixtures'
import { spawnBundledRipgrep } from './bundled-ripgrep-spawn'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let requests: WorkerThreadChildRequest['type'][]
let child: WorkerThreadChildProcess

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  requests = []
  wslAwareSpawnMock.mockReset()
  workerSpawn.mockReset().mockImplementation(() => {
    child = new WorkerThreadChildProcess(7, (request) => {
      requests.push(request.type)
      return true
    })
    return child
  })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
})

const output = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('bundled rg on the Windows process worker', () => {
  it('lists Markdown documents from a worker child, without creating rg on main', async () => {
    const listing = listMarkdownDocuments('C:\\repo')

    expect(workerSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'C:\\orca\\rg.exe', cwd: 'C:\\repo' })
    )
    child.receive({ type: 'spawn', id: 7, pid: 4646 })
    child.receive({ type: 'stdout', id: 7, chunk: output('./README.md\0./docs/gu') })
    child.receive({ type: 'stdout', id: 7, chunk: output('ide.md\0') })
    child.receive({ type: 'exit', id: 7, code: 0, signal: null })
    child.receive({ type: 'close', id: 7, code: 0, signal: null })

    const documents = await listing
    expect(documents.map((document) => document.relativePath)).toEqual([
      'docs/guide.md',
      'README.md'
    ])
    expect(requests).toContain('stdin-end')
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
  })

  it('stops a listing whose worker has not reported the spawn yet', async () => {
    const abort = new AbortController()
    const listing = listMarkdownDocuments('C:\\repo', { signal: abort.signal })

    abort.abort(new Error('superseded'))

    await expect(listing).rejects.toThrow('superseded')
    expect(requests).toContain('kill')
  })

  it('keeps a piped stdin open for the caller', () => {
    const rg = spawnBundledRipgrep(['--files'], {
      cwd: 'C:\repo',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    rg.stdin?.write('pattern')

    expect(requests).toEqual(['stdin-write'])
  })

  it.each([{ signal: new AbortController().signal }, { timeout: 1000 }])(
    'keeps a launch with %o on the inline spawn',
    (option) => {
      spawnBundledRipgrep(['--files'], {
        cwd: 'C:\repo',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...option
      })

      expect(workerSpawn).not.toHaveBeenCalled()
      expect(wslAwareSpawnMock).toHaveBeenCalledTimes(1)
    }
  )

  it('marks a worker launch that never started as a failed spawn before its error', () => {
    const rg = spawnBundledRipgrep(['--files'], {
      cwd: 'C:\repo',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let killedOnError: boolean | undefined
    rg.on('error', () => {
      killedOnError = killSpawnedRipgrepProcess(rg)
    })
    expect(Object.hasOwn(rg, 'pid')).toBe(false)

    child.receive({
      type: 'spawn-error',
      id: 7,
      error: { message: 'spawn rg.exe ENOENT', code: 'ENOENT' }
    })

    expect(killedOnError).toBe(false)
    expect(requests).not.toContain('kill')
  })

  it('decodes a character split across chunks and flushes a partial one before close', () => {
    const rg = spawnBundledRipgrep(['--files'], {
      cwd: 'C:\repo',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const events: string[] = []
    rg.stdout?.setEncoding('utf8')
    rg.stdout?.on('data', (text: string) => events.push(text))
    rg.on('close', () => events.push('close'))
    const euro = output('€')

    child.receive({ type: 'stdout', id: 7, chunk: output('aé').subarray(0, 2) })
    child.receive({ type: 'stdout', id: 7, chunk: Uint8Array.of(0xa9, ...euro.subarray(0, 1)) })
    child.receive({ type: 'stdout', id: 7, chunk: euro.subarray(1) })
    child.receive({ type: 'stdout', id: 7, chunk: euro.subarray(0, 2) })
    child.receive({ type: 'close', id: 7, code: 0, signal: null })

    expect(events).toEqual(['a', 'é', '€', '�', 'close'])
  })
})

describe('a missing bundled rg on a real process worker', () => {
  let entry: Awaited<ReturnType<typeof createWorkerThreadChildProcessTestEntry>>
  let host: ReturnType<typeof createWorkerThreadChildProcessTestHost>
  beforeAll(async () => {
    entry = await createWorkerThreadChildProcessTestEntry()
    host = createWorkerThreadChildProcessTestHost(entry.entryPath)
    host.releaseOutput()
  }, 60_000)
  afterAll(async () => {
    await host.dispose()
    await entry.dispose()
  })

  it('reaches its error listener as a failed spawn, as a Node child does', async () => {
    workerSpawn.mockImplementation((spec) => host.spawn(spec))
    const rg = spawnBundledRipgrep(['--files'], {
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const seen = await new Promise<{ code: unknown; unavailable: boolean }>((resolve) => {
      rg.once('error', (error: NodeJS.ErrnoException) =>
        resolve({ code: error.code, unavailable: isRipgrepUnavailableExit(rg, null, null) })
      )
    })

    expect(seen).toEqual({ code: 'ENOENT', unavailable: true })
  })
})
