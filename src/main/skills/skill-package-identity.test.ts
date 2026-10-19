import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeObservedSkillFile,
  matchesBundledSkillFiles,
  observeSkillPackage
} from './skill-package-identity'

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
  it('matches CRLF installed text to LF bundled files', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'first\r\nsecond\r\n')
    const observed = await observeSkillPackage(root)
    const expected = describeObservedSkillFile('SKILL.md', Buffer.from('first\nsecond\n'), false)

    // Why: scans can observe several package byte budgets concurrently; only
    // hashes, not raw file buffers, should survive each file's identity pass.
    expect(observed.files[0]).not.toHaveProperty('bytes')
    expect(matchesBundledSkillFiles(observed, [expected])).toBe(true)
  })

  it('uses exact bytes for executable and binary files', async () => {
    const executable = describeObservedSkillFile('run.sh', Buffer.from('#!/bin/sh\r\n'), true)
    const binary = describeObservedSkillFile('asset.bin', Buffer.from([0, 13, 10]), false)
    expect(executable.identitySha256).toBe(executable.exactSha256)
    expect(binary.identitySha256).toBe(binary.exactSha256)
    expect(binary.classification).toBe('binary')
  })

  it('infers shebang scripts as executable on Windows filesystems', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'skill\n')
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho ok\n')

    const observed = await observeSkillPackage(root, undefined, undefined, undefined, 'win32', true)

    expect(observed.files.find((file) => file.path === 'run.sh')?.executable).toBe(true)
    expect(observed.files.find((file) => file.path === 'SKILL.md')?.executable).toBe(false)
  })

  it('matches receipt executable paths case-insensitively on Windows', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'skill\n')
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho ok\n')

    const observed = await observeSkillPackage(
      root,
      undefined,
      new Set(['Run.sh']),
      undefined,
      'win32'
    )

    expect(observed.files.find((file) => file.path === 'run.sh')?.executable).toBe(true)
  })

  it('orders package files by locale-independent code units', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'apple.md'), 'apple')
    await writeFile(join(root, 'Zebra.md'), 'zebra')

    const observed = await observeSkillPackage(root)

    expect(observed.files.map((file) => file.path)).toEqual(['Zebra.md', 'apple.md'])
  })

  it('rejects links and bounded-observation overflows', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'skill')
    if (process.platform !== 'win32') {
      await symlink(join(root, 'SKILL.md'), join(root, 'linked.md'))
      await expect(observeSkillPackage(root)).rejects.toThrow('skill-package-link')
      await rm(join(root, 'linked.md'))
    }
    await expect(
      observeSkillPackage(root, {
        maximumDepth: 1,
        maximumEntries: 0,
        maximumFiles: 1,
        maximumSingleFileBytes: 10,
        maximumTotalBytes: 10
      })
    ).rejects.toThrow('skill-package-entry-limit')
  })

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

  it('ignores OS-authored sidecars so a browsed folder still matches the bundle', async () => {
    const pristine = await temporarySkill()
    await writeFile(join(pristine, 'SKILL.md'), 'skill\n')
    const official = await observeSkillPackage(pristine)

    const browsed = await temporarySkill()
    await writeFile(join(browsed, 'SKILL.md'), 'skill\n')
    // Every name the OS writes on its own, including one that sorts BEFORE SKILL.md.
    await writeFile(join(browsed, '.DS_Store'), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(browsed, '._SKILL.md'), Buffer.from([0, 5]))
    await writeFile(join(browsed, 'Thumbs.db'), Buffer.from([9]))
    await writeFile(join(browsed, 'desktop.ini'), '[.ShellClassInfo]\n')

    const observed = await observeSkillPackage(browsed)

    expect(observed.files.map((file) => file.path)).toEqual(['SKILL.md'])
    expect(observed.observedDigest).toBe(official.observedDigest)
    expect(matchesBundledSkillFiles(observed, official.files)).toBe(true)
  })

  it('keeps guarding a directory or link that only wears an OS metadata name', async () => {
    const root = await temporarySkill()
    await writeFile(join(root, 'SKILL.md'), 'skill\n')
    // The OS writes these names as plain files only, so a subtree behind one is real content:
    // dropping it on the name alone would hide it from identity and read as pristine.
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

  it('still reports a genuinely modified skill as unmatched', async () => {
    const pristine = await temporarySkill()
    await writeFile(join(pristine, 'SKILL.md'), 'skill\n')
    const official = await observeSkillPackage(pristine)

    const edited = await temporarySkill()
    await writeFile(join(edited, 'SKILL.md'), 'skill\nlocal tweak\n')
    await writeFile(join(edited, '.DS_Store'), Buffer.from([0, 1]))
    // Extra sidecar next to an untouched SKILL.md must still match — agent CLIs
    // write agents/openai.yaml (and similar) without editing official bytes.
    const withPayload = await temporarySkill()
    await writeFile(join(withPayload, 'SKILL.md'), 'skill\n')
    await mkdir(join(withPayload, 'agents'), { recursive: true })
    await writeFile(join(withPayload, 'agents', 'openai.yaml'), 'display_name: test\n')

    expect(matchesBundledSkillFiles(await observeSkillPackage(edited), official.files)).toBe(false)
    expect(matchesBundledSkillFiles(await observeSkillPackage(withPayload), official.files)).toBe(
      true
    )
  })

  it('reports a missing bundled file as unmatched', async () => {
    const shipped = await temporarySkill()
    await writeFile(join(shipped, 'SKILL.md'), 'skill\n')
    await mkdir(join(shipped, 'references'), { recursive: true })
    await writeFile(join(shipped, 'references', 'x.md'), 'reference\n')
    const official = await observeSkillPackage(shipped)

    const partial = await temporarySkill()
    await writeFile(join(partial, 'SKILL.md'), 'skill\n')

    expect(matchesBundledSkillFiles(await observeSkillPackage(partial), official.files)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('tracks executable mode in package identity', async () => {
    const root = await temporarySkill()
    await mkdir(join(root, 'scripts'))
    const script = join(root, 'scripts', 'run.sh')
    await writeFile(script, '#!/bin/sh\n')
    await chmod(script, 0o755)
    const observed = await observeSkillPackage(root)
    expect(observed.files[0]?.executable).toBe(true)
  })
})
