import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFileCommandHost } from './runtime-file-command-host'

const mocks = vi.hoisted(() => ({
  resolvePath: vi.fn(),
  expectation: vi.fn(),
  provider: vi.fn(),
  authorize: vi.fn(),
  requireStore: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  writeBuffer: vi.fn()
}))

vi.mock('./runtime-file-commands-read-file-explorer-preview', () => ({
  RuntimeFileCommandsWithReadFileExplorerPreview: class {
    resolveFileExplorerPath = mocks.resolvePath
    host = { requireStore: mocks.requireStore }
  }
}))
vi.mock('./runtime-file-commands-mobile-file-list-limit', () => ({
  assertRuntimeFileMutationExpectation: mocks.expectation
}))
vi.mock('./runtime-file-command-target', () => ({ requireRuntimeFileProvider: mocks.provider }))
vi.mock('../ipc/filesystem-auth', () => ({ resolveAuthorizedPath: mocks.authorize }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile
}))

import { RuntimeFileCommandsWithWriteFileExplorerFile } from './runtime-file-commands-write-file-explorer-file'
import { createLocalFilesystemProvider } from '../providers/local-filesystem-provider'

function unexpectedHostCall(): never {
  throw new Error('Unexpected access beyond the isolated file command')
}

const host: RuntimeFileCommandHost = {
  getRuntimeId: unexpectedHostCall,
  requireStore: unexpectedHostCall,
  resolveWorktreeSelector: unexpectedHostCall,
  resolveRuntimeFileTarget: unexpectedHostCall,
  resolveRuntimeGitTarget: unexpectedHostCall,
  openFile: unexpectedHostCall,
  openDiff: unexpectedHostCall
}
const commands = new RuntimeFileCommandsWithWriteFileExplorerFile(host)
const destination = join('workspace', 'uploads', 'binary.dat')
const target = { executionHostId: 'local', path: destination }
let remote = false

beforeEach(() => {
  vi.resetAllMocks()
  remote = false
  mocks.resolvePath.mockResolvedValue(target)
  mocks.provider.mockImplementation((_target, host) =>
    createLocalFilesystemProvider({
      requireStore: () => host.requireStore(),
      resolveAuthorizedPath: mocks.authorize
    })
  )
  mocks.authorize.mockResolvedValue(destination)
  mocks.requireStore.mockReturnValue({})
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.writeBuffer.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

describe.each(['whole', 'first', 'append'] as const)('runtime %s base64 write', (mode) => {
  const write = (base64: string) => {
    if (remote) {
      return mode === 'whole'
        ? commands.writeFileExplorerFileBase64(
            'folder:workspace',
            'uploads/binary.dat',
            base64,
            7,
            'target',
            'ssh:target'
          )
        : commands.writeFileExplorerFileBase64Chunk(
            'folder:workspace',
            'uploads/binary.dat',
            base64,
            mode === 'append',
            7,
            'target',
            'ssh:target'
          )
    }
    return mode === 'whole'
      ? commands.writeFileExplorerFileBase64(
          'folder:workspace',
          'uploads/binary.dat',
          base64,
          undefined,
          undefined,
          'local'
        )
      : commands.writeFileExplorerFileBase64Chunk(
          'folder:workspace',
          'uploads/binary.dat',
          base64,
          mode === 'append',
          undefined,
          undefined,
          'local'
        )
  }

  it.each(['', 'AAH+/w==', 'AA', '%%%'])(
    'preserves local decoding and flags for %j',
    async (base64) => {
      const expected = Buffer.from(base64, 'base64')
      const decode = vi.spyOn(Buffer, 'from')
      await expect(write(base64)).resolves.toEqual({ ok: true })
      expect(
        decode.mock.calls.filter((args) => args.at(0) === base64 && args.at(1) === 'base64')
      ).toHaveLength(1)
      expect(mocks.expectation).toHaveBeenCalledWith('local', 'local', undefined, undefined)
      expect(mocks.provider).toHaveBeenCalledWith(target, expect.anything())
      expect(mocks.authorize).toHaveBeenCalledWith(
        destination,
        mocks.requireStore.mock.results[0].value
      )
      expect(mocks.mkdir).toHaveBeenCalledWith(dirname(destination), { recursive: true })
      expect(mocks.writeFile).toHaveBeenCalledWith(destination, expected, {
        flag: mode === 'append' ? 'a' : 'wx'
      })
      expect(mocks.writeBuffer).not.toHaveBeenCalled()
      expect(mocks.expectation.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.provider.mock.invocationCallOrder[0]
      )
      expect(decode.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.authorize.mock.invocationCallOrder[0]
      )
    }
  )

  it.each(['resolve', 'expectation', 'provider'] as const)(
    'preserves %s failure before decoding or writes',
    async (stage) => {
      const failure = new Error(stage)
      if (stage === 'resolve') {
        mocks.resolvePath.mockRejectedValue(failure)
      } else if (stage === 'expectation') {
        mocks.expectation.mockImplementation(() => {
          throw failure
        })
      } else {
        mocks.provider.mockImplementation(() => {
          throw failure
        })
      }
      const decode = vi.spyOn(Buffer, 'from')
      await expect(write('AA==')).rejects.toBe(failure)
      expect(decode).not.toHaveBeenCalled()
      expect(mocks.authorize).not.toHaveBeenCalled()
      expect(mocks.writeFile).not.toHaveBeenCalled()
      expect(mocks.writeBuffer).not.toHaveBeenCalled()
      if (stage === 'resolve') {
        expect(mocks.expectation).not.toHaveBeenCalled()
      }
      if (stage !== 'provider') {
        expect(mocks.provider).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['authorize', 'mkdir', 'writeFile'] as const)(
    'preserves local %s failure without a remote fallback',
    async (stage) => {
      const failure = new Error(stage)
      mocks[stage].mockRejectedValue(failure)
      await expect(write('AA==')).rejects.toBe(failure)
      expect(mocks.writeBuffer).not.toHaveBeenCalled()
      if (stage !== 'writeFile') {
        expect(mocks.writeFile).not.toHaveBeenCalled()
      }
    }
  )
})
