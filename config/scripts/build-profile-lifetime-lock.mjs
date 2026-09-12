#!/usr/bin/env node
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from './script-child-process.mjs'
import { nodeGypRebuildInvocation } from './windows-process-tree-gyp-rebuild.mjs'
import { verifyLinuxGlibcFloor } from './verify-linux-glibc-floor.cjs'

const root = resolve(import.meta.dirname, '../..')

// Candidate-only artifact: deliberately outside production packaging and runtime lookup.
export function buildProfileLifetimeLock({
  platform = process.platform,
  arch = process.arch,
  run = runProcessSync,
  verifyFloor = verifyLinuxGlibcFloor,
  outputRoot = join(root, '.build', 'profile-lifetime-lock')
} = {}) {
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('Profile lifetime lock must be built on the target platform and architecture')
  }
  const temporary = mkdtempSync(join(tmpdir(), 'orca-profile-lock-build-'))
  try {
    for (const name of ['binding.gyp', 'profile-lifetime-lock.c']) {
      copyFileSync(join(root, 'native', 'profile-lifetime-lock', name), join(temporary, name))
    }
    const invocation = nodeGypRebuildInvocation(arch, temporary)
    const result = run({
      program: process.execPath,
      args: invocation.args,
      cwd: invocation.cwd,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    if (result.code !== 0) {
      throw new Error(`Profile lifetime lock build failed: ${result.stderr || result.stdout}`)
    }
    const compiled = join(temporary, 'build', 'Release')
    if (platform === 'linux') {
      verifyFloor(compiled, { targetArch: arch })
    }
    const destination = join(outputRoot, `${platform}-${arch}`)
    mkdirSync(destination, { recursive: true })
    const artifact = join(destination, 'profile-lifetime-lock.node')
    copyFileSync(join(compiled, 'profile-lifetime-lock.node'), artifact)
    return artifact
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(buildProfileLifetimeLock())
}
