import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectLinkedFile } from './linked-file-inspection'

const MACH_O = Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 1)

describe.skipIf(process.platform === 'win32')('inspectLinkedFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-linked-file-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function file(name: string, content: string | Uint8Array, mode = 0o644): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, content)
    await chmod(path, mode)
    return path
  }

  it('reads the content of +x files whatever their name', async () => {
    expect(await inspectLinkedFile(await file('notes.md', '#!/bin/sh\n', 0o755))).toBe(
      'view-as-text'
    )
    expect(await inspectLinkedFile(await file('tool', MACH_O, 0o755))).toBe('reveal')
    expect(await inspectLinkedFile(await file('shared.md', '# Shared\n', 0o777))).toBe('open')
  })

  it('follows symlinks to the real file', async () => {
    const script = await file('real.sh', 'echo hi\n')
    const program = await file('real-tool', MACH_O, 0o755)
    await symlink(script, join(dir, 'notes.txt'))
    await symlink(program, join(dir, 'report.pdf'))
    await symlink(join(dir, 'notes.txt'), join(dir, 'readme.md'))

    expect(await inspectLinkedFile(join(dir, 'notes.txt'))).toBe('view-as-text')
    expect(await inspectLinkedFile(join(dir, 'report.pdf'))).toBe('reveal')
    expect(await inspectLinkedFile(join(dir, 'readme.md'))).toBe('view-as-text')
  })

  it('reveals bundles and anything it cannot inspect', async () => {
    await mkdir(join(dir, 'Tool.app'))
    await mkdir(join(dir, 'docs'))

    expect(await inspectLinkedFile(join(dir, 'Tool.app'))).toBe('reveal')
    expect(await inspectLinkedFile(join(dir, 'docs'))).toBe('open')
    expect(await inspectLinkedFile(join(dir, 'missing.md'))).toBe('reveal')
  })
})
