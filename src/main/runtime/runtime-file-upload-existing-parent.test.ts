import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRuntimeFileCommands } from './orca-runtime-files-test-harness'
import { ClipboardImageImportStaging } from '../window/clipboard-image-import-staging'
import { stageOneSourceForRuntimeUpload } from '../ipc/filesystem-runtime-upload-staging'
import {
  RUNTIME_UPLOAD_SLICE_BYTES,
  streamExternalFileToRuntime
} from '../ipc/runtime-upload-file-stream'

const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: (...args: unknown[]) => transport.call(...args)
}))

let root: string
let destination: string
let commands: ReturnType<typeof createRuntimeFileCommands>['commands']
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-upload-existing-parent-'))
  destination = join(root, 'workspace', 'imagens com espaços')
  await mkdir(destination, { recursive: true })
  const runtime = createRuntimeFileCommands({ path: join(root, 'workspace') })
  commands = runtime.commands
  Object.assign(runtime.store, {
    getRepos: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [{ folderPath: join(root, 'workspace'), projectGroupId: 'group' }]
  })
  transport.call.mockReset()
})
afterEach(() => rm(root, { recursive: true, force: true }))

const temporary = 'imagens com espaços/.pasted-image.png.orca-upload-test'
const final = 'imagens com espaços/pasted-image.png'
function writeChunk(append = false, requireExistingParent = true) {
  return commands.writeFileExplorerFileBase64Chunk(
    'folder:notes',
    temporary,
    Buffer.from('pixels').toString('base64'),
    append,
    undefined,
    undefined,
    'local',
    requireExistingParent
  )
}
function commit(requireExistingParent = true) {
  return commands.commitFileExplorerUpload(
    'folder:notes',
    temporary,
    final,
    undefined,
    undefined,
    'local',
    requireExistingParent
  )
}

it('fails the first chunk when the selected directory has been removed', async () => {
  await rm(destination, { recursive: true })
  await expect(writeChunk()).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not recreate the directory or temporary file between chunks', async () => {
  await writeChunk()
  await rm(destination, { recursive: true })
  await expect(writeChunk(true)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  await mkdir(destination)
  await expect(writeChunk(true)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(join(root, 'workspace', temporary))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not recreate the directory if it disappears before commit', async () => {
  await writeChunk()
  await rm(destination, { recursive: true })
  await expect(commit()).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves an existing final file when another writer wins the name', async () => {
  await writeChunk()
  await writeFile(join(root, 'workspace', final), 'other writer')
  await expect(commit()).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(join(root, 'workspace', final), 'utf8')).toBe('other writer')
})

it('preserves directory creation for callers without the strict policy', async () => {
  await rm(destination, { recursive: true })
  await writeChunk(false, false)
  await commit(false)
  expect(await readFile(join(root, 'workspace', final), 'utf8')).toBe('pixels')
})

it('keeps workspace containment and owner checks on strict uploads', async () => {
  await expect(
    commands.writeFileExplorerFileBase64Chunk(
      'folder:notes',
      '../outside.png',
      '',
      false,
      undefined,
      undefined,
      'local',
      true
    )
  ).rejects.toThrow()
  await expect(
    commands.writeFileExplorerFileBase64Chunk(
      'folder:notes',
      temporary,
      '',
      false,
      undefined,
      undefined,
      'ssh:other',
      true
    )
  ).rejects.toThrow('Workspace host changed')
  await expect(lstat(join(root, 'workspace', temporary))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['success', 'removed-during-staging', 'removed-during-upload'] as const)(
  'streams managed staging through real authorization and filesystem writes: %s',
  async (scenario) => {
    const staging = new ClipboardImageImportStaging(join(root, 'profile'))
    const bytes = Buffer.alloc(RUNTIME_UPLOAD_SLICE_BYTES + 3, 42)
    const snapshot = await staging.stage(1, bytes, new AbortController().signal)
    try {
      if (scenario === 'removed-during-staging') {
        await rm(destination, { recursive: true })
      }
      const source = await stageOneSourceForRuntimeUpload(snapshot.path)
      expect(source.status).toBe('staged')
      if (source.status !== 'staged') {
        throw new Error('Staging failed')
      }
      const entry = source.entries[0]
      if (entry.kind !== 'file') {
        throw new Error('Expected staged file')
      }
      let chunks = 0
      transport.call.mockImplementation(async (_userData, _environment, _method, params) => {
        expect(params.requireExistingParent).toBe(true)
        await commands.writeFileExplorerFileBase64Chunk(
          params.worktree,
          params.relativePath,
          params.contentBase64,
          params.append,
          params.expectedSshConnectionGeneration,
          params.expectedSshTargetId,
          params.expectedExecutionHostId,
          params.requireExistingParent
        )
        chunks++
        if (scenario === 'removed-during-upload' && chunks === 1) {
          await rm(destination, { recursive: true })
        }
        return { id: 'chunk', ok: true, result: { ok: true } }
      })
      const upload = streamExternalFileToRuntime({
        userDataPath: join(root, 'profile'),
        environmentId: 'env-test',
        sourceRootPath: snapshot.path,
        entryRelativePath: '',
        expected: entry,
        worktree: 'folder:notes',
        relativePath: temporary,
        expectedExecutionHostId: 'local',
        requireExistingParent: true
      })
      if (scenario === 'success') {
        await expect(upload).resolves.toEqual({ byteLength: bytes.length })
        await commit()
        expect(await readFile(join(root, 'workspace', final))).toEqual(bytes)
      } else {
        await expect(upload).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      expect(await staging.release(1, snapshot.handle)).toBe(true)
    }
    await expect(lstat(snapshot.path)).rejects.toMatchObject({ code: 'ENOENT' })
    if (scenario === 'success') {
      expect(await readFile(join(root, 'workspace', final))).toEqual(bytes)
    }
  }
)
