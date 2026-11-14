import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { observeSkillPackage } from './skill-package-identity'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

async function temporarySkill(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-skill-freshness-'))
  temporaryDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('skill package identity', () => {
  it.runIf(process.platform !== 'win32')('rejects hardlinks, FIFOs, and Unix sockets', async () => {
    const root = await temporarySkill()
    const source = join(root, 'SKILL.md')
    await writeFile(source, 'skill')
    await link(source, join(root, 'hardlink.md'))
    await expect(observeSkillPackage(root)).rejects.toThrow('skill-package-link')
    await rm(join(root, 'hardlink.md'))

    const fifo = join(root, 'named-pipe')
    await execFileAsync('mkfifo', [fifo])
    await expect(observeSkillPackage(root)).rejects.toThrow('skill-package-special-file')
    await rm(fifo)

    const socket = join(root, 'unix-socket')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
    try {
      await expect(observeSkillPackage(root)).rejects.toThrow('skill-package-special-file')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('keeps guarding a directory or link that only wears an OS metadata name', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'skill\n')
    // Metadata names are safe only as plain files; a matching directory is real content.
    await mkdir(join(root, '._scripts'))
    await writeFile(join(root, '._scripts', 'payload.sh'), '#!/bin/sh\n')

    expect((await observeSkillPackage(root)).files.map((file) => file.path)).toEqual([
      '._scripts/payload.sh',
      'SKILL.md'
    ])

    if (process.platform !== 'win32') {
      await rm(join(root, '._scripts'), { recursive: true })
      await symlink(join(root, 'SKILL.md'), join(root, '._DS_Store'))
      await expect(observeSkillPackage(root)).rejects.toThrow('skill-package-link')
    }
  })
})
