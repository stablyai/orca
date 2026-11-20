import type * as WorkerThreadChildProcessModule from '../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildRequest } from '../worker-thread-child-process/worker-thread-child-process-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
})
