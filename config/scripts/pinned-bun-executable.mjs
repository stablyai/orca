import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export function readPinnedBunVersion(root) {
  return readFileSync(path.join(root, 'config', '.bun-version'), 'utf8').trim()
}

/** `bun --version` of `program`, or null when it does not run. */
export function probeBunVersion(program, root, runProcessSync) {
  try {
    const probe = runProcessSync({
      program,
      args: ['--version'],
      cwd: root,
      env: process.env,
      timeoutMs: 2000,
      maxOutputBytes: 4096
    })
    return probe.code === 0 && !probe.signal && !probe.timedOut ? probe.stdout.trim() : null
  } catch {
    return null
  }
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
    return probeBunVersion(executable, root, runProcessSync) === readPinnedBunVersion(root)
      ? executable
      : null
  } catch {
    return null
  }
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/

// Why not src/shared/app-version.ts: importing .ts from here warns on every test run and CLI build.
function compareVersionCores(left, right) {
  const [a, b] = [VERSION.exec(left), VERSION.exec(right)]
  return Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2]) || Number(a[3]) - Number(b[3])
}

/**
 * Whether a Bun of version `found` may run the tests pinned to `pinned`. Only an older Bun is
 * refused (it silently runs no tests in files that reach newer builtins); a newer one passes.
 */
export function checkBunVersion(found, pinned) {
  if (!found || !VERSION.test(found) || !VERSION.test(pinned)) {
    return {
      ok: true,
      message: `Could not read the Bun version (found "${found ?? ''}", pinned ${pinned}); continuing.`
    }
  }
  if (compareVersionCores(found, pinned) >= 0) {
    return { ok: true }
  }
  return {
    ok: false,
    message:
      `Bun ${found} is older than the pinned ${pinned} (config/.bun-version). ` +
      `Run \`pnpm install\` to install the pinned Bun, or \`bun upgrade\`.`
  }
}
