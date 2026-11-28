import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveDesktopAuthorizedPath = vi.fn()

vi.mock('../../../ipc/filesystem/access/local-file-access-resolution', () => ({
  resolveDesktopAuthorizedPath: (...args: unknown[]) => resolveDesktopAuthorizedPath(...args),
  resolveLocalWriteRequestPath: vi.fn(),
  resolveLocalListRequestPath: vi.fn()
}))

vi.mock('../../../ipc/agent-attachments/agent-session-attachment-upload-ipc', () => ({
  registerAgentSessionAttachmentUploadHandlers: vi.fn()
}))

vi.mock('../../../ipc/filesystem/mutations/filesystem-mutations', () => ({
  registerFilesystemMutationHandlers: vi.fn()
}))

import { getDiskBaselineSignature } from '../../../../shared/file-write/disk-baseline-signature'
import { registerFilesystemWriteHandlers } from '../../../ipc/filesystem/mutations/filesystem-write-handlers'

const EMPTY_SIGNATURE = getDiskBaselineSignature('')

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()

function register(): void {
  registerFilesystemWriteHandlers(
    { store: {} } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `handle` is exercised.
    { handle: (channel, listener) => handlers.set(channel, listener) } as never
  )
}

describe('fs:deletePathIfUnchanged', () => {
  let directory: string

  beforeEach(async () => {
    handlers.clear()
    resolveDesktopAuthorizedPath.mockReset()
    directory = await mkdtemp(join(tmpdir(), 'orca-untitled-'))
    resolveDesktopAuthorizedPath.mockImplementation(async (path: string) => path)
    register()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const invoke = (path: string, expectedSignature: string): unknown => {
    const handler = handlers.get('fs:deletePathIfUnchanged')
    expect(handler).toBeDefined()
    return handler!(null, {
      targetPath: path,
      diskPrecondition: { expectedSignature, requireLosslessUtf8: true }
    })
  }

  it('deletes an empty placeholder that still holds the pinned bytes', async () => {
    const path = join(directory, 'untitled.md')
    await writeFile(path, '')

    await expect(invoke(path, EMPTY_SIGNATURE)).resolves.toEqual({ ok: true })
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a file that gained content, so a writer landing meanwhile is never deleted', async () => {
    const path = join(directory, 'untitled.md')
    await writeFile(path, 'text an agent wrote')

    await expect(invoke(path, EMPTY_SIGNATURE)).resolves.toEqual({
      ok: false,
      diskConflict: 'changed'
    })
    await expect(readFile(path, 'utf8')).resolves.toBe('text an agent wrote')
  })

  it('treats an already-missing placeholder as gone', async () => {
    await expect(invoke(join(directory, 'untitled.md'), EMPTY_SIGNATURE)).resolves.toEqual({
      ok: false,
      diskConflict: 'missing'
    })
  })
})
