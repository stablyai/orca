import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { buildSync, version } from 'esbuild'

function sourceStamp(path) {
  const { mtimeMs, ctimeMs, size, ino } = statSync(path)
  return { path, mtimeMs, ctimeMs, size, ino }
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function createVitestZodBundle(root) {
  const entry = fileURLToPath(import.meta.resolve('zod'))
  const identity = createHash('sha256')
    .update(readFileSync(import.meta.filename))
    .update(JSON.stringify([entry, version, process.platform, process.arch]))
    .digest('hex')
  const temporary = join(root, '.cache', 'build', 'vitest-zod')
  mkdirSync(temporary, { recursive: true })
  const index = join(temporary, `${identity}.json`)
  try {
    const cached = JSON.parse(readFileSync(index, 'utf8'))
    if (
      cached.identity === identity &&
      typeof cached.directory === 'string' &&
      /^[\w-]+$/.test(cached.directory) &&
      Array.isArray(cached.inputs) &&
      cached.inputs.length > 0 &&
      cached.inputs.every(
        (input) => JSON.stringify(sourceStamp(input.path)) === JSON.stringify(input)
      ) &&
      ['zod.mjs', 'zod.mjs.map'].every(
        (file) => digest(join(temporary, cached.directory, file)) === cached.outputs[file]
      )
    ) {
      return { path: join(temporary, cached.directory, 'zod.mjs'), cleanup() {} }
    }
  } catch {
    // Missing or malformed cache data is rebuilt.
  }
  const started = performance.timeOrigin + performance.now()
  const directory = mkdtempSync(join(temporary, 'bundle-'))
  const path = join(directory, 'zod.mjs')
  const cleanup = () => rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  try {
    const result = buildSync({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile: path,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      sourcemap: true,
      metafile: true
    })
    const inputs = Object.keys(result.metafile.inputs)
      .sort()
      .map((file) => sourceStamp(resolve(root, file)))
    if (inputs.some((input) => input.ctimeMs > started)) {
      return { path, cleanup }
    }
    const record = {
      identity,
      directory: directory.slice(temporary.length + 1),
      inputs,
      outputs: Object.fromEntries(
        ['zod.mjs', 'zod.mjs.map'].map((file) => [file, digest(join(directory, file))])
      )
    }
    const pending = `${index}.${process.pid}`
    try {
      writeFileSync(pending, JSON.stringify(record))
      renameSync(pending, index)
    } catch {
      return { path, cleanup }
    } finally {
      rmSync(pending, { force: true })
    }
    return { path, cleanup() {} }
  } catch (error) {
    cleanup()
    throw error
  }
}
