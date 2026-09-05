import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  NODE_PTY_WINDOWS_RUNTIME_FILES,
  WINDOWS_MACHINE_BY_ARCH,
  readPortableExecutableMachine,
  stageWindowsNodePtyPrebuild
} = require('../windows-node-pty-prebuild.cjs')

const tempDirectories = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('Windows node-pty prebuild staging', () => {
  it('replaces host build output with verified target-architecture files', async () => {
    const projectDir = await createProject('arm64')
    const staleReleaseFile = join(
      projectDir,
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'host-x64.node'
    )
    mkdirSync(dirname(staleReleaseFile), { recursive: true })
    writeFileSync(staleReleaseFile, 'stale')

    const releaseDir = stageWindowsNodePtyPrebuild(projectDir, 'arm64')

    await expect(readFile(staleReleaseFile)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const relativePath of NODE_PTY_WINDOWS_RUNTIME_FILES) {
      expect(readPortableExecutableMachine(join(releaseDir, relativePath))).toBe(
        WINDOWS_MACHINE_BY_ARCH.arm64
      )
    }
  })

  it('rejects a prebuild whose PE machine does not match the target', async () => {
    const projectDir = await createProject('arm64')
    const sourceFile = join(
      projectDir,
      'node_modules',
      'node-pty',
      'prebuilds',
      'win32-arm64',
      'conpty.node'
    )
    writePortableExecutable(sourceFile, WINDOWS_MACHINE_BY_ARCH.x64)

    expect(() => stageWindowsNodePtyPrebuild(projectDir, 'arm64')).toThrow(/expected arm64/)
  })
})

async function createProject(architecture) {
  const projectDir = await mkdtemp(join(tmpdir(), 'orca-node-pty-prebuild-'))
  tempDirectories.push(projectDir)
  const sourceDir = join(
    projectDir,
    'node_modules',
    'node-pty',
    'prebuilds',
    `win32-${architecture}`
  )
  for (const relativePath of NODE_PTY_WINDOWS_RUNTIME_FILES) {
    writePortableExecutable(join(sourceDir, relativePath), WINDOWS_MACHINE_BY_ARCH[architecture])
  }
  return projectDir
}

function writePortableExecutable(filePath, machine) {
  mkdirSync(dirname(filePath), { recursive: true })
  const file = openSync(filePath, 'w')
  try {
    const header = Buffer.alloc(128)
    header.writeUInt16LE(0x5a4d, 0)
    header.writeUInt32LE(64, 0x3c)
    header.writeUInt32LE(0x00004550, 64)
    header.writeUInt16LE(machine, 68)
    writeSync(file, header)
  } finally {
    closeSync(file)
  }
}
