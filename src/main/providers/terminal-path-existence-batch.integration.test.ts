import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathsExistOnRelay } from '../../relay/fs-path-existence'
import { statRelayPath } from '../../relay/fs-path-metadata-requests'
import { readSshPathExistenceBatch } from './ssh-filesystem-path-existence'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn)
  },
  shell: {},
  dialog: {}
}))

import { registerShellHandlers } from '../ipc/shell'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }

  root = undefined
  handlers.clear()
})

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'orca-link-batch-'))
  const paths = Array.from({ length: 8 }, (_, i) => join(root!, `file-${i}.ts`))
  await Promise.all(paths.map((path) => writeFile(path, 'fixture')))

  return paths
}

it('one actual shell IPC handler probes eight distinct temporary files and retains scalar answers', async () => {
  const paths = await fixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This registration fixture never invokes unrelated store operations.
  registerShellHandlers({} as never)
  const all = [...paths, join(root!, 'missing'), root!]
  expect(await handlers.get('shell:pathsExist')!(null, all)).toEqual(
    await Promise.all(all.map((path) => handlers.get('shell:pathExists')!(null, path)))
  )
  expect(await handlers.get('shell:pathsExist')!(null, all)).toEqual([
    ...paths.map(() => true),
    false,
    true
  ])
  await expect(handlers.get('shell:pathsExist')!(null, Array(129).fill('x'))).rejects.toThrow(
    'Invalid'
  )
})

it('one real relay batch serves eight distinct SSH paths after one shared capability probe', async () => {
  const paths = await fixture()

  const request = vi.fn(async (method: string, params: Record<string, unknown>) =>
    method === 'fs.getCapabilities' ? { pathExistenceBatchVersion: 1 } : pathsExistOnRelay(params)
  )

  const scalar = vi.fn((path: string) => statRelayPath({ filePath: path }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements request, the only multiplexer operation exercised here.
  const mux = { request } as never
  expect(await readSshPathExistenceBatch(mux, paths, scalar)).toEqual(
    paths.map(() => ({ exists: true }))
  )
  expect(request.mock.calls.map((c) => c[0])).toEqual(['fs.getCapabilities', 'fs.pathsExist'])
  expect(scalar).not.toHaveBeenCalled()
  await rm(paths[0])
  expect(await readSshPathExistenceBatch(mux, [paths[0]], scalar)).toEqual([{ exists: false }])
  await writeFile(paths[0], 'new')
  expect(await readSshPathExistenceBatch(mux, [paths[0]], scalar)).toEqual([{ exists: true }])
  expect(request.mock.calls.filter((c) => c[0] === 'fs.getCapabilities')).toHaveLength(1)
})

it('old relay falls back on the same host without retrying a missing capability document', async () => {
  const paths = await fixture()

  const request = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('method not found'), { code: JsonRpcErrorCode.MethodNotFound })
    )

  const scalar = vi.fn((path: string) => statRelayPath({ filePath: path }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements request, the only multiplexer operation exercised here.
  const mux = { request } as never
  expect(await readSshPathExistenceBatch(mux, paths, scalar)).toEqual(
    paths.map(() => ({ exists: true }))
  )
  expect(scalar).toHaveBeenCalledTimes(8)
  await readSshPathExistenceBatch(mux, [paths[0]], scalar)
  expect(request).toHaveBeenCalledTimes(1)
})

it('connection failure is neither a missing path nor permission to use local/scalar fallback', async () => {
  const scalar = vi.fn()
  const request = vi.fn().mockRejectedValue(new Error('connection closed'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements request, the only multiplexer operation exercised here.
  const mux = { request } as never
  await expect(readSshPathExistenceBatch(mux, ['/remote/path'], scalar)).rejects.toThrow(
    'connection closed'
  )
  expect(scalar).not.toHaveBeenCalled()
  request
    .mockResolvedValueOnce({ pathExistenceBatchVersion: 1 })
    .mockResolvedValueOnce([{ error: 'EACCES denied' }])
  expect(await readSshPathExistenceBatch(mux, ['/remote/path'], scalar)).toEqual([
    { error: 'EACCES denied' }
  ])
  expect(request).toHaveBeenCalledTimes(3)
})

it('malformed batch replies fail rather than manufacturing negative cache entries', async () => {
  const scalar = vi.fn()

  const request = vi
    .fn()
    .mockResolvedValueOnce({ pathExistenceBatchVersion: 1 })
    .mockResolvedValueOnce([])

  await expect(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements request, the only multiplexer operation exercised here.
    readSshPathExistenceBatch({ request } as never, ['/remote/path'], scalar)
  ).rejects.toThrow('Invalid path existence response')
  expect(scalar).not.toHaveBeenCalled()
})
