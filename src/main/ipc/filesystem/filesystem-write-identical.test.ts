import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import { NOT_A_REGULAR_FILE_MESSAGE } from './local-regular-file-read'
import { registerFilesystemWriteHandlers } from './filesystem-write-handlers'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

const handlers = vi.hoisted(() => new Map<string, (_event: unknown, args: unknown) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (_event: unknown, args: unknown) => unknown) =>
      handlers.set(name, handler)
  },
  shell: {}
}))
vi.mock('../local-file-access-resolution', () => ({
  resolveLocalWriteRequestPath: async (path: string) => path
}))
vi.mock('./filesystem-mutations', () => ({ registerFilesystemMutationHandlers: vi.fn() }))
vi.mock('../agent-session-attachment-upload-ipc', () => ({
  registerAgentSessionAttachmentUploadHandlers: vi.fn()
}))

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-identical-ipc-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: authorization is stubbed, and no other context member is used by this handler.
  registerFilesystemWriteHandlers({ store: {} } as FilesystemHandlerContext)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  handlers.clear()
})

it('accepts identical content on a readable, non-writable file through IPC', async () => {
  const filePath = join(root, 'read-only.txt')
  await writeFile(filePath, 'edited')
  await chmod(filePath, 0o444)
  try {
    await expect(
      handlers.get('fs:writeFile')!(null, {
        filePath,
        content: 'edited',
        diskPrecondition: { expectedSignature: getDiskBaselineSignature('original') }
      })
    ).resolves.toEqual({ ok: true, unchanged: true })
    expect(await readFile(filePath, 'utf8')).toBe('edited')
  } finally {
    await chmod(filePath, 0o644)
  }
})

it
  .skipIf(process.platform === 'win32')
  .each([undefined, { expectedSignature: getDiskBaselineSignature('') }])(
  'still refuses non-regular files through IPC (%j)',
  async (diskPrecondition) => {
    await expect(
      handlers.get('fs:writeFile')!(null, { filePath: '/dev/null', content: '', diskPrecondition })
    ).rejects.toThrow(NOT_A_REGULAR_FILE_MESSAGE)
  }
)
