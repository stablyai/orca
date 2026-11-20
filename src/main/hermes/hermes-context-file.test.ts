import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HERMES_CONTEXT_FILE, writeHermesContextFile } from './hermes-context-file'

let home = ''
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hermes-context-file-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('Hermes context file', () => {
  it('replaces the whole file and leaves the folder’s other files alone', async () => {
    await writeFile(join(home, 'AGENTS.md'), 'pointer')
    await writeFile(join(home, HERMES_CONTEXT_FILE), 'an older preamble that was much longer')
    const path = await writeHermesContextFile(home, 'You are Zorblax.')
    expect(path).toBe(join(home, HERMES_CONTEXT_FILE))
    const written = await readFile(path, 'utf8')
    expect(written).toMatch(/You are Zorblax\.\n$/)
    expect(written).not.toContain('older preamble')
    expect((await readdir(home)).sort()).toEqual([HERMES_CONTEXT_FILE, 'AGENTS.md'].sort())
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it('starts with no YAML frontmatter for Hermes to strip', async () => {
    await writeHermesContextFile(home, '---\ntitle: x\n---\nYou are Zorblax.')
    expect(await readFile(join(home, HERMES_CONTEXT_FILE), 'utf8')).toMatch(/^<!--/)
  })
})
