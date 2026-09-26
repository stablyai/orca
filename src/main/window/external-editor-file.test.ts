import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authorize = vi.hoisted(() => vi.fn())
vi.mock('../ipc/filesystem-auth', () => ({ authorizeExternalPath: authorize }))
import { authorizeExternalEditorFile } from './external-editor-file'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-editor-test-'))
  authorize.mockClear()
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('external editor files', () => {
  it.each(['prompt.txt', 'prompt.md', 'prompt'])(
    'accepts existing UTF-8 %s without modifying it',
    async (name) => {
      const path = join(directory, name)
      await writeFile(path, '日本語\r\n$5 **literal**\n')
      await expect(authorizeExternalEditorFile(path)).resolves.toBe(await realpath(path))
      expect(authorize).toHaveBeenCalledWith(await realpath(path))
    }
  )

  it('handles empty prompt files', async () => {
    const path = join(directory, 'empty')
    await writeFile(path, '')
    await authorizeExternalEditorFile(path)
    expect(authorize).toHaveBeenCalledOnce()
  })

  it.skipIf(process.platform === 'win32')(
    'canonicalizes symlinks so /tmp aliases share one editor identity',
    async () => {
      const path = join(directory, 'prompt')
      const alias = join(directory, 'alias')
      await writeFile(path, 'text')
      await symlink(path, alias)
      await expect(authorizeExternalEditorFile(alias)).resolves.toBe(await realpath(path))
    }
  )

  it.each([Buffer.from([0, 1]), Buffer.from([0xff]), Buffer.alloc(1024 * 1024 + 1, 65)])(
    'rejects invalid or oversized content before authorizing',
    async (content) => {
      const path = join(directory, 'bad')
      await writeFile(path, content)
      await expect(authorizeExternalEditorFile(path)).rejects.toThrow()
      expect(authorize).not.toHaveBeenCalled()
    }
  )

  it('rejects a binary-format extension even when its current bytes are text', async () => {
    const path = join(directory, 'image.png')
    await writeFile(path, 'not an image')
    await expect(authorizeExternalEditorFile(path)).rejects.toThrow('text file')
    expect(authorize).not.toHaveBeenCalled()
  })

  it('rejects missing files, directories and relative paths', async () => {
    const folder = join(directory, 'folder')
    await mkdir(folder)
    for (const path of [join(directory, 'missing'), folder, 'relative.txt']) {
      await expect(authorizeExternalEditorFile(path)).rejects.toThrow()
    }
    expect(authorize).not.toHaveBeenCalled()
  })
})
