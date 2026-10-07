import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NATIVE_CHAT_VISUAL_MAX_BYTES } from '../../shared/native-chat-visual-directive'
import { nativeChatVisualsFolderFor } from './native-chat-visuals-folder'
import { nativeChatVisualRevision, readNativeChatVisualFile } from './native-chat-visual-file-read'

const posixIt = process.platform === 'win32' ? it.skip : it

let stateDirectory: string
let folder: string

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-visual-read-'))
  folder = nativeChatVisualsFolderFor(stateDirectory, 'session-alpha')
  await mkdir(folder, { recursive: true })
})

afterEach(async () => {
  await rm(stateDirectory, { recursive: true, force: true })
})

describe('nativeChatVisualsFolderFor', () => {
  it('places each chat in its own hashed folder under the state directory', () => {
    const alpha = nativeChatVisualsFolderFor('/state', 'session-alpha')
    const beta = nativeChatVisualsFolderFor('/state', 'session-beta')
    expect(alpha).toMatch(/native-chat-visuals[\\/][0-9a-f]{32}$/)
    expect(alpha.startsWith(join('/state', 'native-chat-visuals'))).toBe(true)
    expect(alpha).not.toBe(beta)
  })
})

describe('readNativeChatVisualFile', () => {
  it('reads a UTF-8 visual with its revision and size', async () => {
    const html = '<!doctype html><p>Grüße</p>'
    await writeFile(join(folder, 'chart.html'), html)
    const result = await readNativeChatVisualFile(folder, 'chart.html')
    expect(result).toEqual({
      ok: true,
      html,
      revision: nativeChatVisualRevision(Buffer.from(html)),
      sizeBytes: Buffer.byteLength(html)
    })
  })

  it('answers unchanged without the bytes when the client already holds the revision', async () => {
    await writeFile(join(folder, 'chart.html'), '<p>a</p>')
    const first = await readNativeChatVisualFile(folder, 'chart.html')
    if (!first.ok) {
      throw new Error('expected a read')
    }
    const again = await readNativeChatVisualFile(folder, 'chart.html', first.revision)
    expect(again).toEqual({ ok: true, revision: first.revision, sizeBytes: 8, unchanged: true })

    await writeFile(join(folder, 'chart.html'), '<p>b</p>')
    const changed = await readNativeChatVisualFile(folder, 'chart.html', first.revision)
    expect(changed).toMatchObject({ ok: true, html: '<p>b</p>' })
  })

  it('reports a missing file or a missing folder as not_found', async () => {
    expect(await readNativeChatVisualFile(folder, 'nope.html')).toEqual({
      ok: false,
      error: 'not_found'
    })
    const absent = nativeChatVisualsFolderFor(stateDirectory, 'session-never')
    expect(await readNativeChatVisualFile(absent, 'chart.html')).toEqual({
      ok: false,
      error: 'not_found'
    })
  })

  it('refuses names that are not a bare visual file name', async () => {
    await mkdir(join(stateDirectory, 'other'), { recursive: true })
    await writeFile(join(stateDirectory, 'other', 'secret.html'), 'secret')
    for (const name of ['../other/secret.html', '/etc/hosts', 'chart.txt', 'sub/chart.html']) {
      expect(await readNativeChatVisualFile(folder, name)).toEqual({
        ok: false,
        error: 'outside_folder'
      })
    }
  })

  posixIt('refuses a symlink to a sibling chat folder or another workspace', async () => {
    const sibling = nativeChatVisualsFolderFor(stateDirectory, 'session-beta')
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
    const root = join(stateDirectory, 'native-chat-visuals')
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

  it('refuses a directory named like a visual', async () => {
    await mkdir(join(folder, 'dir.html'))
    expect(await readNativeChatVisualFile(folder, 'dir.html')).toEqual({
      ok: false,
      error: 'not_a_file'
    })
  })

  posixIt('refuses a FIFO without waiting for a writer', async () => {
    execFileSync('mkfifo', [join(folder, 'pipe.html')])
    expect(await readNativeChatVisualFile(folder, 'pipe.html')).toEqual({
      ok: false,
      error: 'not_a_file'
    })
  })

  it('refuses a file over the byte cap and accepts one exactly at it', async () => {
    await writeFile(join(folder, 'max.html'), 'a'.repeat(NATIVE_CHAT_VISUAL_MAX_BYTES))
    expect(await readNativeChatVisualFile(folder, 'max.html')).toMatchObject({ ok: true })
    await writeFile(join(folder, 'big.html'), 'a'.repeat(NATIVE_CHAT_VISUAL_MAX_BYTES + 1))
    expect(await readNativeChatVisualFile(folder, 'big.html')).toEqual({
      ok: false,
      error: 'too_large'
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

  it('reads a hard link the agent made inside its own folder', async () => {
    // A hard link grants nothing a copy would not: the agent could write the same bytes itself.
    await writeFile(join(folder, 'a.html'), '<p>a</p>')
    await link(join(folder, 'a.html'), join(folder, 'b.html'))
    expect(await readNativeChatVisualFile(folder, 'b.html')).toMatchObject({ ok: true })
  })

  it('reads the replacement after a file is swapped for new content', async () => {
    await writeFile(join(folder, 'chart.html'), '<p>old</p>')
    await rm(join(folder, 'chart.html'))
    await writeFile(join(folder, 'chart.html'), '<p>new</p>')
    expect(await readNativeChatVisualFile(folder, 'chart.html')).toMatchObject({
      ok: true,
      html: '<p>new</p>'
    })
  })

  posixIt('reports an unexpected filesystem fault without the host path', async () => {
    await writeFile(join(folder, 'chart.html'), '<p>a</p>')
    await chmod(join(folder, 'chart.html'), 0o000)
    try {
      const failure = await readNativeChatVisualFile(folder, 'chart.html').then(
        () => null,
        (error: unknown) => error
      )
      // Root reads through the mode bits; everyone else gets the coded fault.
      if (failure !== null) {
        expect(String(failure)).toContain('visual_read_failed:EACCES')
        expect(String(failure)).not.toContain(stateDirectory)
      }
    } finally {
      await chmod(join(folder, 'chart.html'), 0o644)
    }
  })
})
