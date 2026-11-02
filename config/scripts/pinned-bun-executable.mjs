import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export function readPinnedBunVersion(root) {
  return readFileSync(path.join(root, 'config', '.bun-version'), 'utf8').trim()
}

/**
 * Absolute path of the `bun` devDependency when it runs and is exactly the version in
 * config/.bun-version, otherwise null. Its binary is only real once the postinstall ran.
 */
export function resolvePinnedBunExecutable(root, runProcessSync) {
  try {
    const manifestPath = createRequire(path.join(root, 'package.json')).resolve('bun/package.json')
    const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const executable = path.join(path.dirname(manifestPath), bin.bun)
    const probe = runProcessSync({
      program: executable,
      args: ['--version'],
      cwd: root,
      env: process.env,
      timeoutMs: 2000,
      maxOutputBytes: 4096
    })
    return probe.code === 0 &&
      !probe.signal &&
      !probe.timedOut &&
      probe.stdout.trim() === readPinnedBunVersion(root)
      ? executable
      : null
  } catch {
    return null
  }
}
