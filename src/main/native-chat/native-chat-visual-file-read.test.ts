import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nativeChatScratchFolderFor } from './native-chat-scratch-folder'
import { readNativeChatVisualFile } from './native-chat-visual-file-read'

const posixIt = process.platform === 'win32' ? it.skip : it

let stateDirectory: string
let folder: string

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-visual-read-'))
  folder = nativeChatScratchFolderFor(stateDirectory, 'session-alpha')
  await mkdir(folder, { recursive: true })
})

afterEach(async () => {
  await rm(stateDirectory, { recursive: true, force: true })
})

describe('readNativeChatVisualFile', () => {
  posixIt('refuses a symlink to a sibling chat folder or another workspace', async () => {
    const sibling = nativeChatScratchFolderFor(stateDirectory, 'session-beta')
    await mkdir(sibling, { recursive: true })
    await writeFile(join(sibling, 'theirs.html'), '<p>other chat</p>')
    const worktree = join(stateDirectory, 'worktree')
    await mkdir(worktree)
    await writeFile(join(worktree, 'index.html'), '<p>repo</p>')

    await symlink(join(sibling, 'theirs.html'), join(folder, 'theirs.html'))
    await symlink(join(worktree, 'index.html'), join(folder, 'repo.html'))
    await symlink(join(folder, 'missing-target.html'), join(folder, 'dangling.html'))

    for (const name of ['theirs.html', 'repo.html', 'dangling.html']) {
      expect(await readNativeChatVisualFile(folder, name)).toEqual({
        ok: false,
        error: 'outside_folder'
      })
    }
  })

  posixIt('refuses a visuals folder replaced by a symlink', async () => {
    const elsewhere = join(stateDirectory, 'elsewhere')
    await mkdir(elsewhere)
    await writeFile(join(elsewhere, 'chart.html'), '<p>elsewhere</p>')
    await rm(folder, { recursive: true })
    await symlink(elsewhere, folder)
    expect(await readNativeChatVisualFile(folder, 'chart.html')).toEqual({
      ok: false,
      error: 'outside_folder'
    })
  })

  posixIt('refuses when the shared visuals root is a symlink', async () => {
    const root = join(stateDirectory, 'chat-scratch')
    const moved = join(stateDirectory, 'moved-root')
    await rm(root, { recursive: true })
    await mkdir(join(moved, 'x'), { recursive: true })
    await symlink(moved, root)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'chart.html'), '<p>a</p>')
    expect(await readNativeChatVisualFile(folder, 'chart.html')).toEqual({
      ok: false,
      error: 'outside_folder'
    })
  })

  posixIt('refuses a FIFO without waiting for a writer', async () => {
    execFileSync('mkfifo', [join(folder, 'pipe.html')])
    expect(await readNativeChatVisualFile(folder, 'pipe.html')).toEqual({
      ok: false,
      error: 'not_a_file'
    })
  })

  it('refuses binary and invalid UTF-8 content', async () => {
    await writeFile(join(folder, 'zero-byte.html'), Buffer.from([0x3c, 0x00, 0x3e]))
    await writeFile(join(folder, 'latin1.html'), Buffer.from([0x3c, 0xe9, 0x3e]))
    expect(await readNativeChatVisualFile(folder, 'zero-byte.html')).toEqual({
      ok: false,
      error: 'not_text'
    })
    expect(await readNativeChatVisualFile(folder, 'latin1.html')).toEqual({
      ok: false,
      error: 'not_text'
    })
  })
})
