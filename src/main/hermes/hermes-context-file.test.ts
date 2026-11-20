import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HERMES_CONTEXT_FILE, writeHermesContextFile } from './hermes-context-file'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hermes-context-'))
})
afterEach(async () => {
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

  it('writes through a symlink and keeps text that merely quotes the markers', async () => {
    const target = join(dir, 'AGENTS.md')
    await writeFile(target, 'Note: <!-- orca:begin --> is a marker.\n\nImportant rules.\n')
    await symlink(target, join(dir, HERMES_CONTEXT_FILE))
    await writeHermesContextFile(dir, 'first text')
    await writeHermesContextFile(dir, 'second text')
    expect((await lstat(join(dir, HERMES_CONTEXT_FILE))).isSymbolicLink()).toBe(true)
    const content = await readFile(target, 'utf8')
    expect(content).toContain('Important rules.')
    expect(content).toContain('second text')
    expect(content).not.toContain('first text')
  })

  it('leaves a dangling symlink alone', async () => {
    await symlink(join(dir, 'missing.md'), join(dir, HERMES_CONTEXT_FILE))
    await writeHermesContextFile(dir, 'text')
    expect((await lstat(join(dir, HERMES_CONTEXT_FILE))).isSymbolicLink()).toBe(true)
  })
})
