import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { join, resolve } from 'node:path'
import {
  chmod,
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  symlink,
  readlink
} from 'node:fs/promises'

// Bundle worktree-symlinks.ts with esbuild, then run this against that bundle on the owning host.
const [bundlePath, filesystemRoot, expected] = process.argv.slice(2)
assert(
  bundlePath && filesystemRoot && ['clone', 'fallback'].includes(expected),
  'Usage: node exercise-worktree-cow.mjs <bundle.cjs> <filesystem-root> <clone|fallback>'
)
const materialization = createRequire(import.meta.url)(resolve(bundlePath))
const root = await mkdtemp(join(resolve(filesystemRoot), 'orca-cow-exercise-'))
const source = join(root, 'source')
const target = join(root, 'target')
const payload = Buffer.alloc(2 * 1024 * 1024, 65)
try {
  await mkdir(join(source, 'dependencies', 'package'), { recursive: true })
  await mkdir(target)
  await writeFile(join(source, 'dependencies', 'package', 'data'), payload)
  await writeFile(join(source, 'small'), 'small private content')
  if (process.platform !== 'win32') {
    await symlink('package/data', join(source, 'dependencies', 'entry'))
    await chmod(join(source, 'dependencies', 'package'), 0o500)
  }
  const start = performance.now()
  const skipped = await materialization.createWorktreeCopiedPaths(
    source,
    target,
    ['dependencies'],
    {
      copyBudget: { maxBytes: 64, maxEntries: 100 }
    }
  )
  const elapsedMs = performance.now() - start
  if (expected === 'clone') {
    assert.deepEqual(skipped, [])
    const copy = join(target, 'dependencies', 'package', 'data')
    assert.deepEqual(await readFile(copy), payload)
    await writeFile(copy, 'changed')
    assert.deepEqual(await readFile(join(source, 'dependencies', 'package', 'data')), payload)
    assert.equal(await readlink(join(target, 'dependencies', 'entry')), 'package/data')
    assert.equal((await lstat(join(target, 'dependencies', 'package'))).mode & 0o777, 0o500)
  } else {
    assert.deepEqual(skipped, [{ path: 'dependencies', reason: 'bytes' }])
    await assert.rejects(lstat(join(target, 'dependencies')), { code: 'ENOENT' })
  }
  assert.deepEqual(await materialization.createWorktreeCopiedPaths(source, target, ['small']), [])
  await writeFile(join(target, 'small'), 'changed')
  assert.equal(await readFile(join(source, 'small'), 'utf8'), 'small private content')
  await materialization.createWorktreeCopiedPaths(source, target, ['small'])
  assert.equal(await readFile(join(target, 'small'), 'utf8'), 'changed')

  const linked = join(root, 'linked')
  const shared = join(root, 'shared')
  await mkdir(linked)
  await mkdir(shared)
  await materialization.createWorktreeLinkedPaths(source, linked, ['dependencies'])
  assert.equal(
    (await lstat(join(linked, 'dependencies'))).isSymbolicLink(),
    expected === 'fallback'
  )
  await materialization.createWorktreeSharedPaths(source, shared, ['dependencies'])
  assert.equal((await lstat(join(shared, 'dependencies'))).isSymbolicLink(), true)
  for (const directory of [source, target, linked, shared]) {
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.startsWith('.orca-')),
      []
    )
  }
  console.log(JSON.stringify({ platform: process.platform, expected, elapsedMs, passed: true }))
} finally {
  if (process.platform !== 'win32') {
    for (const name of ['source', 'target', 'linked']) {
      await chmod(join(root, name, 'dependencies', 'package'), 0o700).catch(() => {})
    }
  }
  await rm(root, { recursive: true, force: true })
}
