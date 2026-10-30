import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync, version as esbuildVersion } from 'esbuild'

const CACHE_DIRECTORY = 'vitest-zod-cache'
// No run lasts this long, so an older bundle directory is not in use.
const STALE_AGE_MS = 6 * 60 * 60 * 1000

function removeIfStale(path, now) {
  try {
    if (now - statSync(path).mtimeMs > STALE_AGE_MS) {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 })
    }
  } catch {
    // Another launcher may be removing it too.
  }
}

/** Per-run directories that older launchers leaked when killed, and superseded cache keys. */
function sweepStaleBundles(temporary, cache, key) {
  const now = Date.now()
  for (const name of readdirSync(temporary)) {
    if (name.startsWith('vitest-zod-') && name !== CACHE_DIRECTORY) {
      removeIfStale(join(temporary, name), now)
    }
  }
  for (const name of readdirSync(cache)) {
    if (name !== key && !name.startsWith(`.${key}-`)) {
      removeIfStale(join(cache, name), now)
    }
  }
}

// Reuse worker-shared ESM bundles keyed by installed Zod, esbuild and builder content; killed runs need no cleanup.
export function createVitestZodBundle(root) {
  const entry = fileURLToPath(import.meta.resolve('zod'))
  const manifest = createRequire(entry).resolve('zod/package.json')
  const key = createHash('sha256')
    .update(JSON.stringify([entry, readFileSync(manifest, 'utf8'), esbuildVersion]))
    .update(readFileSync(import.meta.filename))
    .digest('hex')
    .slice(0, 16)
  const temporary = join(root, '.tmp')
  const cache = join(temporary, CACHE_DIRECTORY)
  const path = join(cache, key, 'zod.mjs')
  mkdirSync(cache, { recursive: true })
  sweepStaleBundles(temporary, cache, key)
  if (existsSync(path)) {
    return { path }
  }
  // Built beside the final directory, then renamed, so readers never see a partial bundle.
  const staging = join(cache, `.${key}-${process.pid}-${Date.now()}`)
  try {
    buildSync({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile: join(staging, 'zod.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      sourcemap: true
    })
    try {
      renameSync(staging, dirname(path))
    } catch (error) {
      if (!existsSync(path)) {
        throw error
      }
    }
    return { path }
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 3 })
  }
}
