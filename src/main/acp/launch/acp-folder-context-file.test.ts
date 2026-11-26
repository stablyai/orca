import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeFolderContextFile, writeFolderContextFile } from './acp-folder-context-file'

// Runs once right after the next read of the context file, as a user's editor saving meanwhile.
let saveAfterNextRead: (() => Promise<void>) | null = null
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const content = await fs.readFile(...args)
      const save = saveAfterNextRead
      saveAfterNextRead = null
      await save?.()
      return content
    }
  }
})

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
    ],
    [
      'a file that already holds the text',
      '<!-- Orca writes this file for Hermes chats in this folder; edits are replaced. -->\n\nprivate text\n'
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
})

it("takes Orca's text back out of a context file and keeps the user's", async () => {
  const orcaOwn = join(dir, 'own')
  await mkdir(orcaOwn)
  await writeFolderContextFile(orcaOwn, 'GEMINI.md', 'Gemini', 'bot preamble')
  await removeFolderContextFile(orcaOwn, 'GEMINI.md', 'Gemini')
  await expect(lstat(join(orcaOwn, 'GEMINI.md'))).rejects.toThrow()

  await writeFile(join(dir, 'GEMINI.md'), 'My own rules.\n')
  await writeFolderContextFile(dir, 'GEMINI.md', 'Gemini', 'bot preamble')
  await removeFolderContextFile(dir, 'GEMINI.md', 'Gemini')
  expect(await readFile(join(dir, 'GEMINI.md'), 'utf8')).toBe('My own rules.\n')
})

it("leaves every byte around Orca's block as the user wrote it", async () => {
  const path = join(dir, 'GEMINI.md')
  const user = '# Rules\r\n\n```\n    indented code\n```\n  \n'
  await writeFile(path, `${user}<!-- orca:begin -->\nbot preamble\n<!-- orca:end -->\n\tmore\n`)
  await removeFolderContextFile(dir, 'GEMINI.md', 'Gemini')
  expect(await readFile(path, 'utf8')).toBe(`${user}\tmore\n`)
})

it("leaves a file that isn't UTF-8 as it is", async () => {
  const path = join(dir, 'GEMINI.md')
  const bytes = Buffer.from('caf\xe9\n\n<!-- orca:begin -->\nbot\n<!-- orca:end -->\n', 'latin1')
  await writeFile(path, bytes)
  await removeFolderContextFile(dir, 'GEMINI.md', 'Gemini')
  expect(await readFile(path)).toEqual(bytes)
})

it.each([
  ['a file Orca wrote', null],
  ['a file the user wrote', 'My own rules.\n']
])("never replaces a save that lands while Orca's text is taken out of %s", async (_, user) => {
  const path = join(dir, 'GEMINI.md')
  if (user !== null) {
    await writeFile(path, user)
  }
  await writeFolderContextFile(dir, 'GEMINI.md', 'Gemini', 'bot preamble')
  const saved = 'Rules saved meanwhile.\n'
  saveAfterNextRead = () => writeFile(path, saved)
  await removeFolderContextFile(dir, 'GEMINI.md', 'Gemini')
  expect(await readFile(path, 'utf8')).toBe(saved)
  expect(await readdir(dir)).toEqual(['GEMINI.md'])
})
