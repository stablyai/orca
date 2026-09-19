import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import type { FilesystemHandlerContext } from './filesystem/filesystem-handler-context'
import { hasSshProviderContinuations } from '../ssh/ssh-provider-continuations'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  advanceSshConnectionGeneration,
  resetSshConnectionGenerations
} from '../ssh/ssh-connection-generation'
import { importExternalPathsSsh } from './filesystem-import-ssh'
import { captureLocalUploadRoot, uploadSshImportDirectory } from './filesystem-import-ssh-directory'
import { registerFilesystemWriteHandlers } from './filesystem/filesystem-write-handlers'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  lstat: vi.fn(),
  writeFile: vi.fn(),
  trashItem: vi.fn(),
  resolveAuthorizedPath: vi.fn(),
  tryDeleteWslUncPath: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle }, shell: mocks }))
vi.mock('node:fs/promises', () => ({ lstat: mocks.lstat, writeFile: mocks.writeFile }))
vi.mock('./filesystem-auth', () => ({
  authorizeExternalPath: vi.fn(),
  resolveAuthorizedPath: mocks.resolveAuthorizedPath
}))
vi.mock('./filesystem-mutations', () => ({ registerFilesystemMutationHandlers: vi.fn() }))
vi.mock('../wsl-unc-delete', () => ({ tryDeleteWslUncPath: mocks.tryDeleteWslUncPath }))
vi.mock('./ssh', () => ({
  getSshConnectionManager: () => ({
    getConnection: () => ({ getState: () => ({ status: 'connected' }) })
  })
}))
vi.mock('./filesystem-import-ssh-directory', () => ({
  captureLocalUploadRoot: vi.fn(),
  preScanSshImportDirectory: vi.fn(),
  uploadSshImportDirectory: vi.fn()
}))

const targetId = 'filesystem-continuation-target'
const handlers = new Map<string, (_event: unknown, args: object) => Promise<unknown>>()
const fileStat = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }

beforeEach(() => {
  vi.resetAllMocks()
  resetSshConnectionGenerations()
  unregisterSshFilesystemProvider(targetId)
  expect(hasSshProviderContinuations(targetId)).toBe(false)
  handlers.clear()
  mocks.handle.mockImplementation((channel, handler) => handlers.set(channel, handler))
  mocks.lstat.mockResolvedValue(fileStat)
  mocks.resolveAuthorizedPath.mockImplementation(async (path) => path)
  mocks.tryDeleteWslUncPath.mockResolvedValue(false)
  registerFilesystemWriteHandlers({ store: {} } as FilesystemHandlerContext)
})

describe('SSH filesystem mutation continuation settlement', () => {
  it.each(['fs:writeFile', 'fs:deletePath'])(
    '%s retains removed providers until settlement',
    async (channel) => {
      const pending = Promise.withResolvers<void>()
      const operation = vi.fn(() => {
        expect(hasSshProviderContinuations(targetId)).toBe(true)
        return pending.promise
      })
      registerSshFilesystemProvider(targetId, {
        writeFile: operation,
        deletePath: operation
      } as unknown as IFilesystemProvider)
      const result = handlers.get(channel)!(null, {
        connectionId: targetId,
        expectedSshTargetId: targetId,
        expectedSshConnectionGeneration: 0,
        filePath: '/remote/file',
        content: 'text',
        targetPath: '/remote/file',
        recursive: true
      })
      unregisterSshFilesystemProvider(targetId)
      advanceSshConnectionGeneration(targetId)
      expect(hasSshProviderContinuations(targetId)).toBe(true)
      expect(hasSshProviderContinuations('other-target')).toBe(false)
      pending.resolve()
      await result
      expect(hasSshProviderContinuations(targetId)).toBe(false)
      expect(operation).toHaveBeenCalledWith(
        ...(channel === 'fs:writeFile' ? ['/remote/file', 'text'] : ['/remote/file', true])
      )
    }
  )

  it.each(['fs:writeFile', 'fs:deletePath'])(
    '%s releases after provider rejection',
    async (channel) => {
      const pending = Promise.withResolvers<void>()
      registerSshFilesystemProvider(targetId, {
        writeFile: () => pending.promise,
        deletePath: () => pending.promise
      } as unknown as IFilesystemProvider)
      const result = handlers.get(channel)!(null, {
        connectionId: targetId,
        expectedSshTargetId: targetId,
        expectedSshConnectionGeneration: 0,
        filePath: '/remote/file',
        targetPath: '/remote/file',
        content: ''
      })
      const failure = expect(result).rejects.toThrow('late failure')
      expect(hasSshProviderContinuations(targetId)).toBe(true)
      pending.reject(new Error('late failure'))
      await failure
      expect(hasSshProviderContinuations(targetId)).toBe(false)
    }
  )

  it.each(['fs:writeFile', 'fs:deletePath'])(
    '%s leaves local handling untracked',
    async (channel) => {
      const pending = Promise.withResolvers<void>()
      mocks.writeFile.mockReturnValue(pending.promise)
      mocks.trashItem.mockReturnValue(pending.promise)
      const result = handlers.get(channel)!(null, {
        filePath: '/local/file',
        targetPath: '/local/file',
        content: 'text'
      })
      expect(hasSshProviderContinuations(targetId)).toBe(false)
      pending.resolve()
      await result
      expect(channel === 'fs:writeFile' ? mocks.writeFile : mocks.trashItem).toHaveBeenCalled()
      expect(hasSshProviderContinuations(targetId)).toBe(false)
    }
  )
})

describe('complete SSH import continuation settlement', () => {
  it('retains a failed directory import through pending rollback', async () => {
    const rollback = Promise.withResolvers<void>()
    const rollingBack = Promise.withResolvers<void>()
    mocks.lstat.mockResolvedValue({ ...fileStat, isDirectory: () => true, isFile: () => false })
    vi.mocked(captureLocalUploadRoot).mockResolvedValue('/source/directory')
    vi.mocked(uploadSshImportDirectory).mockRejectedValue(new Error('upload failed'))
    const close = vi.fn(() => expect(hasSshProviderContinuations(targetId)).toBe(true))
    const deletePath = vi.fn(() => {
      rollingBack.resolve()
      return rollback.promise
    })
    registerSshFilesystemProvider(targetId, {
      openFileUploadSession: async () => ({ close }),
      stat: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      createDirNoClobber: async () => {},
      deletePath
    } as unknown as IFilesystemProvider)
    const result = importExternalPathsSsh(['/source/directory'], '/remote', targetId)
    await rollingBack.promise
    unregisterSshFilesystemProvider(targetId)
    expect(hasSshProviderContinuations(targetId)).toBe(true)
    expect(close).not.toHaveBeenCalled()
    rollback.resolve()
    expect((await result).results[0]).toMatchObject({ status: 'failed', reason: 'upload failed' })
    expect(deletePath).toHaveBeenCalledWith('/remote/directory', true)
    expect(close).toHaveBeenCalledOnce()
    expect(hasSshProviderContinuations(targetId)).toBe(false)
  })

  it('retains tracking across local inspection, provider removal and session close', async () => {
    const inspection = Promise.withResolvers<typeof fileStat>()
    const inspected = Promise.withResolvers<void>()
    const uploaded = Promise.withResolvers<void>()
    const upload = Promise.withResolvers<void>()
    mocks.lstat.mockImplementation(() => {
      inspected.resolve()
      return inspection.promise
    })
    const close = vi.fn(() => expect(hasSshProviderContinuations(targetId)).toBe(true))
    registerSshFilesystemProvider(targetId, {
      openFileUploadSession: async () => ({
        close,
        uploadFile: () => {
          uploaded.resolve()
          return upload.promise
        }
      }),
      stat: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
    } as unknown as IFilesystemProvider)
    const result = importExternalPathsSsh(['/source/file'], '/remote', targetId)
    expect(hasSshProviderContinuations(targetId)).toBe(true)
    await inspected.promise
    unregisterSshFilesystemProvider(targetId)
    advanceSshConnectionGeneration(targetId)
    expect(hasSshProviderContinuations(targetId)).toBe(true)
    inspection.resolve(fileStat)
    await uploaded.promise
    expect(hasSshProviderContinuations(targetId)).toBe(true)
    upload.resolve()
    expect((await result).results[0].status).toBe('imported')
    expect(close).toHaveBeenCalledOnce()
    expect(hasSshProviderContinuations(targetId)).toBe(false)
  })

  it('includes staging preparation and releases on its failure', async () => {
    const staging = Promise.withResolvers<void>()
    registerSshFilesystemProvider(targetId, {
      createDir: () => {
        expect(hasSshProviderContinuations(targetId)).toBe(true)
        return staging.promise
      }
    } as unknown as IFilesystemProvider)
    const result = importExternalPathsSsh(['/source/file'], '/remote/.orca/drops', targetId, {
      ensureDir: true
    })
    const failure = expect(result).rejects.toThrow('staging failed')
    unregisterSshFilesystemProvider(targetId)
    expect(hasSshProviderContinuations(targetId)).toBe(true)
    staging.reject(new Error('staging failed'))
    await failure
    expect(hasSshProviderContinuations(targetId)).toBe(false)
  })
})
