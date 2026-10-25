import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importRuntimeFiles } from './runtime-file-import'

const { callRemote } = vi.hoisted(() => ({ callRemote: vi.fn() }))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRemote
}))
vi.mock('./runtime-environments/runtime-environment-manual-disconnect', () => ({
  isRuntimeEnvironmentManuallyDisconnected: () => false,
  RUNTIME_MANUALLY_DISCONNECTED_MESSAGE: 'Disconnected'
}))

let root: string
let destination: string
let staging: string
const contents = Buffer.alloc(500_000, 0xa3)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-import-test-'))
  destination = join(root, 'destination')
  staging = join(root, 'staging')
  await mkdir(destination)
  await mkdir(staging)
  callRemote.mockReset()
  callRemote.mockImplementation(async (_data, _environment, method, params) => {
    const path = params.relativePath
    let result: unknown
    if (method === 'files.readDir') {
      result =
        path === ''
          ? [{ name: 'folder', isDirectory: true, isSymlink: false }]
          : [
              { name: 'data.bin', isDirectory: false, isSymlink: false },
              { name: 'empty', isDirectory: true, isSymlink: false }
            ]
      if (path === 'folder/empty') {
        result = []
      }
    } else if (method === 'files.stat') {
      result = {
        size: path.endsWith('data.bin') ? contents.length : 0,
        mtime: 123,
        isDirectory: !path.endsWith('data.bin')
      }
    } else {
      const chunk = contents.subarray(params.offset, params.offset + params.length)
      result = {
        contentBase64: chunk.toString('base64'),
        bytesRead: chunk.length,
        eof: params.offset + chunk.length === contents.length
      }
    }
    return { id: 'test', ok: true, result, _meta: { runtimeId: 'server-a' } }
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const request = () => ({
  environmentId: 'remote',
  worktree: 'id:workspace',
  relativePaths: ['folder'],
  destinationDir: destination,
  expectedEnvironmentPairingRevision: 42
})

describe('remote explorer imports', () => {
  it.each(['symlink', 'server-change', 'truncated-file', 'old-server'])(
    'leaves no partial copy when encountering %s',
    async (failure) => {
      const implementation = callRemote.getMockImplementation()!
      callRemote.mockImplementation(async (...args) => {
        const response = await implementation(...args)
        if (
          failure === 'symlink' &&
          args[2] === 'files.readDir' &&
          args[3].relativePath === 'folder'
        ) {
          return { ...response, result: [{ name: 'link', isDirectory: false, isSymlink: true }] }
        }
        if (args[2] === 'files.readChunk') {
          if (failure === 'server-change') {
            return { ...response, _meta: { runtimeId: 'other-server' } }
          }
          if (failure === 'truncated-file') {
            return { ...response, result: { contentBase64: '', bytesRead: 0, eof: true } }
          }
          if (failure === 'old-server') {
            return { ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
          }
        }
        return response
      })
      const result = await importRuntimeFiles(
        request(),
        root,
        staging,
        new AbortController().signal
      )
      expect(result.results[0]).toMatchObject({ status: 'failed' })
      expect(await readdir(destination)).toEqual([])
      expect(await readdir(staging)).toEqual([])
    }
  )

  it('streams binary files and empty folders, deconflicting the complete source tree', async () => {
    await mkdir(join(destination, 'folder'))
    await writeFile(join(destination, 'folder', 'existing.txt'), 'keep')
    const result = await importRuntimeFiles(request(), root, staging, new AbortController().signal)
    expect(result.results).toMatchObject([{ status: 'imported', renamed: true }])
    expect(await readFile(join(destination, 'folder copy', 'data.bin'))).toEqual(contents)
    expect(await readdir(join(destination, 'folder copy', 'empty'))).toEqual([])
    expect(await readFile(join(destination, 'folder', 'existing.txt'), 'utf8')).toBe('keep')
    expect(await readdir(staging)).toEqual([])
    const reads = callRemote.mock.calls.filter((call) => call[2] === 'files.readChunk')
    expect(reads.map((call) => call[3].offset)).toEqual([0, 384 * 1024])
    expect(
      reads.every((call) => call[5] === 42 && call[7].expectedEnvironmentRuntimeId === 'server-a')
    ).toBe(true)
  })

  it('removes partial staging and leaves the destination untouched after a connection failure', async () => {
    const implementation = callRemote.getMockImplementation()!
    callRemote.mockImplementation(async (...args) => {
      if (args[2] === 'files.readChunk' && args[3].offset > 0) {
        throw new Error('Connection lost')
      }
      return implementation(...args)
    })
    expect(
      (await importRuntimeFiles(request(), root, staging, new AbortController().signal)).results
    ).toEqual([{ sourcePath: 'folder', status: 'failed', reason: 'Connection lost' }])
    expect(await readdir(destination)).toEqual([])
    expect(await readdir(staging)).toEqual([])
  })

  it('refuses remote directory entries that escape the staging root', async () => {
    const implementation = callRemote.getMockImplementation()!
    callRemote.mockImplementation(async (...args) => {
      if (args[2] === 'files.readDir' && args[3].relativePath === 'folder') {
        return {
          ok: true,
          result: [{ name: '../escaped', isDirectory: false, isSymlink: false }],
          _meta: { runtimeId: 'server-a' }
        }
      }
      return implementation(...args)
    })
    expect(
      (await importRuntimeFiles(request(), root, staging, new AbortController().signal)).results[0]
    ).toMatchObject({ status: 'failed' })
    expect(await readdir(destination)).toEqual([])
    expect(await readdir(staging)).toEqual([])
  })
})
