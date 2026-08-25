import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getOrcaManagedRepoCliPath,
  installRepoCli,
  probeRepoCli,
  REPO_CLI_INSTALL_INVALID,
  REPO_CLI_PYTHON_MISSING,
  resolveRepoProgram
} from './repo-managed-cli'

const LAUNCHER = `#!/usr/bin/env python3
# Copyright git-repo
REPO_REV = "stable"
# https://gerrit.googlesource.com/git-repo
print("repo")
`

let tempDirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-repo-cli-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('probeRepoCli', () => {
  it('prefers the checkout-bundled repo tool over PATH', async () => {
    const root = await tempRoot()
    const bundled = join(root, '.repo', 'repo', 'repo')
    await mkdir(join(root, '.repo', 'repo'), { recursive: true })
    await writeFile(bundled, LAUNCHER)

    const probe = await probeRepoCli({
      mainPath: root,
      home: join(root, 'home'),
      exists: async (path) => path === bundled,
      runCommand: async ({ program }) => ({
        code: program.startsWith('python') ? 0 : 1,
        stdout: '',
        stderr: ''
      })
    })

    expect(probe).toMatchObject({
      available: true,
      source: 'tree',
      program: bundled,
      pythonAvailable: true
    })
  })

  it('uses the Orca-managed launcher when the tree has none', async () => {
    const root = await tempRoot()
    const home = join(root, 'home')
    const managed = getOrcaManagedRepoCliPath(home)
    await mkdir(join(home, '.orca', 'bin'), { recursive: true })
    await writeFile(managed, LAUNCHER)
    await chmod(managed, 0o755)

    const probe = await probeRepoCli({
      mainPath: join(root, 'tree'),
      home,
      runCommand: async ({ program }) => ({
        code: program.startsWith('python') ? 0 : 1,
        stdout: '',
        stderr: ''
      })
    })

    expect(probe.source).toBe('orca')
    expect(probe.program).toBe(managed)
    expect(probe.available).toBe(true)
  })

  it('reports missing when python is absent even if a launcher exists', async () => {
    const root = await tempRoot()
    const bundled = join(root, '.repo', 'repo', 'repo')
    await mkdir(join(root, '.repo', 'repo'), { recursive: true })
    await writeFile(bundled, LAUNCHER)

    const probe = await probeRepoCli({
      mainPath: root,
      exists: async (path) => path === bundled,
      runCommand: async () => ({ code: 1, stdout: '', stderr: '' })
    })

    expect(probe).toMatchObject({
      available: false,
      source: 'tree',
      pythonAvailable: false
    })
  })

  it('falls back to PATH repo when the tree and Orca launcher are missing', async () => {
    const probe = await probeRepoCli({
      mainPath: '/missing',
      home: '/missing-home',
      exists: async () => false,
      runCommand: async ({ program }) => ({
        code: program.startsWith('python') || program === 'repo' ? 0 : 1,
        stdout: '',
        stderr: ''
      })
    })

    expect(probe).toMatchObject({
      available: true,
      source: 'path',
      program: 'repo',
      pythonAvailable: true
    })
  })
})

describe('installRepoCli', () => {
  it('writes the official launcher under ~/.orca/bin', async () => {
    const root = await tempRoot()
    const home = join(root, 'home')

    const probe = await installRepoCli({
      home,
      download: async () => LAUNCHER,
      runCommand: async ({ program }) => ({
        code: program.startsWith('python') ? 0 : 1,
        stdout: '',
        stderr: ''
      })
    })

    const dest = getOrcaManagedRepoCliPath(home)
    expect(await readFile(dest, 'utf8')).toBe(LAUNCHER)
    expect(probe.source).toBe('orca')
    expect(probe.available).toBe(true)
  })

  it('refuses a download that is not the repo launcher', async () => {
    await expect(
      installRepoCli({
        home: await tempRoot(),
        download: async () => '#!/bin/sh\necho no\n',
        runCommand: async ({ program }) => ({
          code: program.startsWith('python') ? 0 : 1,
          stdout: '',
          stderr: ''
        })
      })
    ).rejects.toThrow(REPO_CLI_INSTALL_INVALID)
  })

  it('refuses to install without Python 3', async () => {
    await expect(
      installRepoCli({
        home: await tempRoot(),
        download: async () => LAUNCHER,
        runCommand: async () => ({ code: 1, stdout: '', stderr: '' })
      })
    ).rejects.toThrow(REPO_CLI_PYTHON_MISSING)
  })
})

describe('resolveRepoProgram', () => {
  it('returns the tree tool when present', async () => {
    const root = await tempRoot()
    const bundled = join(root, '.repo', 'repo', 'repo')
    await mkdir(join(root, '.repo', 'repo'), { recursive: true })
    await writeFile(bundled, LAUNCHER)

    await expect(
      resolveRepoProgram({
        mainPath: root,
        exists: async (path) => path === bundled,
        runCommand: async ({ program }) => ({
          code: program.startsWith('python') ? 0 : 1,
          stdout: '',
          stderr: ''
        })
      })
    ).resolves.toBe(bundled)
  })

  it('returns repo when nothing is installed', async () => {
    await expect(
      resolveRepoProgram({
        mainPath: '/missing',
        home: '/missing-home',
        exists: async () => false,
        runCommand: async () => ({ code: 1, stdout: '', stderr: '' })
      })
    ).resolves.toBe('repo')
  })
})
