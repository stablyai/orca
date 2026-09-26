import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { tempRoot } = vi.hoisted(() => ({ tempRoot: { value: '' } }))

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => tempRoot.value })
}))
const { authorizeExternalPathMock } = vi.hoisted(() => ({ authorizeExternalPathMock: vi.fn() }))
vi.mock('../ipc/filesystem-auth', () => ({ authorizeExternalPath: authorizeExternalPathMock }))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: vi.fn()
}))

import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { saveClipboardImageBufferAsTempFile } from './clipboard-image-temp-file'

it('keeps SSH image paths remote and never authorizes them as client-local files', async () => {
  vi.clearAllMocks()
  const writePrivateFileBase64 = vi.fn().mockResolvedValue(undefined)
  vi.mocked(requireSshFilesystemProvider).mockReturnValue({
    getTempDir: async () => '/remote/tmp',
    writePrivateFileBase64
  } as never)

  const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from('png'), {
    connectionId: 'ssh-1'
  })

  expect(savedPath.startsWith('/remote/tmp/')).toBe(true)
  expect(writePrivateFileBase64).toHaveBeenCalledWith(
    savedPath,
    Buffer.from('png').toString('base64')
  )
  expect(authorizeExternalPathMock).not.toHaveBeenCalled()
})

describe.runIf(process.platform !== 'win32')('saveClipboardImageBufferAsTempFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tempRoot.value = mkdtempSync(join(tmpdir(), 'orca-clipboard-image-test-'))
  })

  afterEach(() => {
    rmSync(tempRoot.value, { recursive: true, force: true })
  })

  it('uses an unpredictable private directory and exclusive private file', async () => {
    const victim = join(tempRoot.value, 'victim')
    mkdirSync(victim)
    symlinkSync(victim, join(tempRoot.value, 'orca-clipboard-images'))

    const savedPath = await saveClipboardImageBufferAsTempFile(Buffer.from('png'))
    expect(authorizeExternalPathMock).toHaveBeenCalledWith(savedPath)
    const privateDir = join(savedPath, '..')

    expect(privateDir).toMatch(/orca-clipboard-images-[^/]+$/)
    expect(readdirSync(victim)).toEqual([])
    expect(statSync(privateDir).mode & 0o777).toBe(0o700)
    expect(statSync(savedPath).mode & 0o777).toBe(0o600)
  })
})
