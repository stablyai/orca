import { afterEach, expect, it, vi } from 'vitest'
import {
  canonicalizeAuthorizedPath,
  isAuthorizedPathSymlink
} from './filesystem-host-authorization'
import { setFilesystemHostReadClientForTests } from './filesystem-host-read-client'
import { FilesystemHostReadAuthority } from './filesystem-host-read-authority'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'

afterEach(() => setFilesystemHostReadClientForTests(null))
it('preserves WSL UNC drive-mount spelling while moving realpath and lstat into the host', async () => {
  const canonicalizePath = vi.fn(async () => 'C:\\repo\\canonical')
  const isSymlink = vi.fn(async () => true)
  setFilesystemHostReadClientForTests({
    canonicalizePath,
    isSymlink,
    readOrcaYaml: async () => '',
    readKeybindings: async () => '',
    readSnapshotFile: async () => Buffer.alloc(0),
    prepareRateLimitPtyCwd: async (path) => path
  })
  const path = '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\repo\\link'
  expect(await canonicalizeAuthorizedPath(path, 'win32')).toBe(
    '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\repo\\canonical'
  )
  expect(canonicalizePath).toHaveBeenCalledWith('C:\\repo\\link', undefined)
  expect(await isAuthorizedPathSymlink(path, 'win32')).toBe(true)
  expect(isSymlink).toHaveBeenCalledWith('C:\\repo\\link')
})
it('maps child lstat absence back to ENOENT and preserves fail-closed permission errors', async () => {
  const dispatch = vi
    .fn()
    .mockRejectedValue(new FilesystemHostSupervisorError('operation', 'missing', 'missing'))
  const authority = new FilesystemHostReadAuthority({
    entryPath: 'unused',
    supervisor: {
      dispatch,
      publishFailureDomain: () => {},
      removeFailureDomain: () => {},
      dispose: async () => {}
    }
  })
  await expect(authority.isSymlink('/missing')).rejects.toMatchObject({ code: 'ENOENT' })
  dispatch.mockRejectedValue(new FilesystemHostSupervisorError('operation', 'denied', 'denied'))
  await expect(authority.isSymlink('/denied')).rejects.toMatchObject({ code: 'EACCES' })
})
