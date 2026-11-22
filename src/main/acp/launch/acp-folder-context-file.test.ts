import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeFolderContextBlock, writeFolderContextFile } from './acp-folder-context-file'

const HERMES_CONTEXT_FILE = '.hermes.md'
const writeHermesContextFile = (cwd: string, text: string) =>
  writeFolderContextFile(cwd, HERMES_CONTEXT_FILE, 'Hermes', text)

let dir = ''
let previousUmask = 0
beforeEach(async () => {
  // A permissive umask, as a login shell often has, so a kept 0644 mode would show.
  previousUmask = process.umask(0o022)
  dir = await mkdtemp(join(tmpdir(), 'hermes-context-'))
})
afterEach(async () => {
  process.umask(previousUmask)
  await rm(dir, { recursive: true, force: true })
})

describe('Hermes context file', () => {
  it('keeps a user-written file and refreshes only Orca block on each launch', async () => {
    const path = join(dir, HERMES_CONTEXT_FILE)
    await writeFile(path, 'My own rules.\n')
    await writeHermesContextFile(dir, 'first text')
    await writeHermesContextFile(dir, 'second text')
    const content = await readFile(path, 'utf8')
    expect(content.startsWith('My own rules.')).toBe(true)
    expect(content).toContain('second text')
    expect(content).not.toContain('first text')
  })

  it('replaces a file Orca wrote', async () => {
    await writeHermesContextFile(dir, 'first text')
    await writeHermesContextFile(dir, 'second text')
    const content = await readFile(join(dir, HERMES_CONTEXT_FILE), 'utf8')
    expect(content).toContain('second text')
    expect(content).not.toContain('first text')
  })

  it.skipIf(process.platform === 'win32').each([
    ['a user-written file', 'My own rules.\n'],
    [
      'a file Orca wrote',
      '<!-- Orca writes this file for Hermes chats in this folder; edits are replaced. -->\n\nold\n'
    ]
  ])('makes %s that others could read private once it carries the text', async (_, content) => {
    const path = join(dir, HERMES_CONTEXT_FILE)
    await writeFile(path, content, { mode: 0o644 })
    await chmod(path, 0o644)
    await writeHermesContextFile(dir, 'private text')
    expect(await readFile(path, 'utf8')).toContain('private text')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('leaves a symlink and its target alone', async () => {
    const target = join(dir, 'AGENTS.md')
    await writeFile(target, 'Important rules.\n')
    await symlink(target, join(dir, HERMES_CONTEXT_FILE))
    await writeHermesContextFile(dir, 'text')
    expect((await lstat(join(dir, HERMES_CONTEXT_FILE))).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('Important rules.\n')
  })

  it.skipIf(process.platform === 'win32')('writes nothing through a linked folder', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kimi-outside-'))
    try {
      await symlink(outside, join(dir, '.kimi-code'))
      await writeFolderContextFile(dir, '.kimi-code/AGENTS.md', 'Kimi Code', 'private text')
      await expect(readFile(join(outside, 'AGENTS.md'), 'utf8')).rejects.toThrow()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('leaves a dangling symlink alone', async () => {
    await symlink(join(dir, 'missing.md'), join(dir, HERMES_CONTEXT_FILE))
    await writeHermesContextFile(dir, 'text')
    expect((await lstat(join(dir, HERMES_CONTEXT_FILE))).isSymbolicLink()).toBe(true)
  })

  it('keeps notes under a stray begin marker and handles CRLF files', async () => {
    const path = join(dir, HERMES_CONTEXT_FILE)
    await writeFile(path, 'intro\r\n<!-- orca:begin -->\r\nKEEP ME\r\n')
    await writeHermesContextFile(dir, 'first')
    await writeHermesContextFile(dir, 'second')
    const content = await readFile(path, 'utf8')
    expect(content).toContain('KEEP ME')
    expect(content).toContain('second')
    expect(content).not.toContain('first')
  })

  it('keeps notes between a complete block and a trailing stray end marker', async () => {
    const path = join(dir, HERMES_CONTEXT_FILE)
    await writeFile(
      path,
      'intro\n<!-- orca:begin -->\nold\n<!-- orca:end -->\nKEEP ME\n<!-- orca:end -->\n'
    )
    await writeHermesContextFile(dir, 'fresh')
    const content = await readFile(path, 'utf8')
    expect(content).toContain('KEEP ME')
    expect(content).toContain('fresh')
    expect(content).not.toContain('old')
  })

  it('takes its block back out and keeps the text the user wrote, indentation included', async () => {
    const path = join(dir, HERMES_CONTEXT_FILE)
    await writeFile(path, '    indented first line\n\nMy own rules.\n')
    await writeHermesContextFile(dir, 'text')
    await removeFolderContextBlock(dir, HERMES_CONTEXT_FILE, 'Hermes')
    expect(await readFile(path, 'utf8')).toBe('    indented first line\n\nMy own rules.\n')
  })

  it('removes the file Orca wrote when the block was all it held', async () => {
    await writeHermesContextFile(dir, 'text')
    await removeFolderContextBlock(dir, HERMES_CONTEXT_FILE, 'Hermes')
    expect(await lstat(join(dir, HERMES_CONTEXT_FILE)).catch(() => null)).toBeNull()
  })
})
