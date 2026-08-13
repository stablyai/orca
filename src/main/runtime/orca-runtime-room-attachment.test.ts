import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  execFile: execFileMock
}))

import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { OrcaRuntimeService } from './orca-runtime'

type StageRuntimeInternals = {
  ptysById: Map<
    string,
    {
      worktreeId: string
      connectionId: string | null
      wslDistro: string | null
    }
  >
  getTerminalAgentStatusPtyId: () => string
  resolveWorktreeSelector: () => Promise<{ path: string }>
}

function runtimeForHost(input: {
  connectionId: string | null
  wslDistro: string | null
}): OrcaRuntimeService {
  const runtime = Object.create(OrcaRuntimeService.prototype) as OrcaRuntimeService
  Object.assign(runtime, {
    ptysById: new Map([
      [
        'pty-1',
        {
          worktreeId: 'worktree-1',
          connectionId: input.connectionId,
          wslDistro: input.wslDistro
        }
      ]
    ]),
    getTerminalAgentStatusPtyId: () => 'pty-1',
    resolveWorktreeSelector: async () => ({ path: '/remote/worktree' })
  } satisfies StageRuntimeInternals)
  return runtime
}

const enoent = (): Error => Object.assign(new Error('missing'), { code: 'ENOENT' })

describe('room attachment delivery path', () => {
  it('uses the canonical local file and one stable native SSH drop', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-room-attachment-stage-'))
    const localPath = join(directory, 'report.pdf')
    await writeFile(localPath, 'report')
    const attachment = { id: 'attachment/42', fileName: 'report.pdf', localPath }

    try {
      const local = runtimeForHost({ connectionId: null, wslDistro: null })
      await expect(local.stageRoomAttachment('worktree-1', 'term-1', attachment)).resolves.toBe(
        localPath
      )

      const files = new Set<string>()
      const uploadFile = vi.fn(async (_source: string, path: string) => {
        files.add(path)
      })
      registerSshFilesystemProvider('ssh-1', {
        createDir: async () => {},
        stat: async (path: string) => {
          if (!files.has(path)) {
            throw enoent()
          }
          return { type: 'file', size: 1, mtime: 1 }
        },
        writeFile: async (path: string) => {
          files.add(path)
        },
        openFileUploadSession: async () => ({ uploadFile, close: () => {} })
      } as never)
      try {
        const ssh = runtimeForHost({ connectionId: 'ssh-1', wslDistro: null })
        const expected = posix.join('/remote/worktree', '.orca', 'drops', 'attachment_42.pdf')
        await expect(ssh.stageRoomAttachment('worktree-1', 'term-1', attachment)).resolves.toBe(
          expected
        )
        await expect(ssh.stageRoomAttachment('worktree-1', 'term-1', attachment)).resolves.toBe(
          expected
        )
        expect(uploadFile).toHaveBeenCalledOnce()
        expect(uploadFile).toHaveBeenCalledWith(localPath, expected, { exclusive: true })
      } finally {
        unregisterSshFilesystemProvider('ssh-1')
      }

      execFileMock.mockImplementation(
        (
          _file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
          callback(null, `/wsl${String(args.at(-1))}`, '')
          return {} as never
        }
      )
      const wsl = runtimeForHost({ connectionId: null, wslDistro: 'Ubuntu' })
      await expect(wsl.stageRoomAttachment('worktree-1', 'term-1', attachment)).resolves.toBe(
        `/wsl${localPath}`
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('deletes only persisted SSH drop paths and tolerates missing files', async () => {
    const deletePath = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(enoent())
    registerSshFilesystemProvider('ssh-1', { deletePath } as never)
    try {
      const runtime = runtimeForHost({ connectionId: null, wslDistro: null })
      await runtime.cleanupDeletedRoomResources({
        roomId: 'room-1',
        attachmentPaths: [],
        pendingUploadIds: [],
        drops: [
          { connectionId: 'ssh-1', remotePath: '/repo/.orca/drops/first.txt' },
          { connectionId: 'ssh-1', remotePath: '/repo/.orca/drops/missing.txt' }
        ]
      })

      expect(deletePath.mock.calls).toEqual([
        ['/repo/.orca/drops/first.txt'],
        ['/repo/.orca/drops/missing.txt']
      ])
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }
  })
})
