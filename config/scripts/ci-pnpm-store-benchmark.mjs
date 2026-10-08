import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'
import { runProcessSync } from './script-child-process.mjs'

const { values } = parseArgs({
  options: { samples: { type: 'string', default: '3' }, output: { type: 'string' } }
})
const samples = Number(values.samples)
assert(Number.isInteger(samples) && samples > 0 && samples <= 10, '--samples must be 1–10')
const repository = resolve(import.meta.dirname, '../..')
const temporary = mkdtempSync(join(tmpdir(), 'orca-ci-pnpm-store-'))
const checkout = join(temporary, 'checkout')
const store = join(temporary, 'store')
const archive = join(temporary, 'store.tar.zst')
const uncompressed = join(temporary, 'store.tar')
const manifests = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
const pnpm = resolvePnpmCliInvocation()
const results = []

function command(program, args, cwd = checkout) {
  const start = performance.now()
  const result = runProcessSync({
    program,
    args,
    cwd,
    env: { ...process.env, CI: 'true', ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 300_000
  })
  assert.equal(result.code, 0, `${program}: ${result.stdout}\n${result.stderr}`)
  return { milliseconds: performance.now() - start, stdout: result.stdout.trim() }
}

function pnpmCommand(args) {
  return command(pnpm.command, [...pnpm.prefixArgs, ...args])
}

function digest() {
  const hash = createHash('sha256')
  for (const file of manifests) {
    hash.update(readFileSync(join(checkout, file)))
  }
  return hash.digest('hex')
}

function install() {
  return pnpmCommand(['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', store])
    .milliseconds
}

function transferArchive(restore) {
  const start = performance.now()
  // Windows BSD tar needs a separate zstd process, as in the Actions cache toolkit.
  if (process.platform === 'win32') {
    if (restore) {
      command('zstd', ['-d', '-f', 'store.tar.zst', '-o', 'store.tar'], temporary)
      command('tar', ['-xf', 'store.tar', '-C', store], temporary)
    } else {
      command('tar', ['--format=posix', '-cf', 'store.tar', '-C', store, '.'], temporary)
      command('zstd', ['-T0', '-f', 'store.tar', '-o', 'store.tar.zst'], temporary)
    }
    rmSync(uncompressed)
  } else {
    command(
      'tar',
      restore
        ? ['-xf', archive, '--use-compress-program', 'zstd -d', '-C', store]
        : ['--format=posix', '-cf', archive, '--use-compress-program', 'zstd -T0', '-C', store, '.']
    )
  }
  return performance.now() - start
}

try {
  mkdirSync(checkout)
  for (const file of [...manifests, 'native/windows-registry/package.json', 'config/patches']) {
    const target = join(checkout, file)
    mkdirSync(resolve(target, '..'), { recursive: true })
    cpSync(join(repository, file), target, { recursive: true })
  }
  const sourceDigest = digest()
  const pnpmVersion = pnpmCommand(['--version']).stdout
  const zstdVersion = command('zstd', ['--version']).stdout
  const tarVersion = command('tar', ['--version']).stdout

  for (let sample = 0; sample < samples; sample++) {
    const policies = sample % 2 === 0 ? ['save', 'restore-only'] : ['restore-only', 'save']
    for (const policy of policies) {
      rmSync(join(checkout, 'node_modules'), { recursive: true, force: true })
      rmSync(store, { recursive: true, force: true })
      const installMs = install()
      assert.equal(digest(), sourceDigest, 'frozen install changed a manifest')
      let archiveMs = 0
      let archiveBytes = 0
      if (policy === 'save') {
        archiveMs = transferArchive(false)
        archiveBytes = statSync(archive).size
      }
      const result = {
        sample,
        policy,
        installMs,
        archiveMs,
        archiveBytes,
        totalMs: installMs + archiveMs
      }
      results.push(result)
      console.error(JSON.stringify(result))
    }
  }

  // Both policies restore identical bytes on a hit; measure that common cost separately.
  rmSync(join(checkout, 'node_modules'), { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
  mkdirSync(store)
  const restoreMs = transferArchive(true)
  const hitInstallMs = install()
  assert.equal(digest(), sourceDigest)
  const report = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    pnpm: pnpmVersion,
    tar: tarVersion,
    zstd: zstdVersion,
    sourceDigest,
    results,
    hit: { restoreMs, installMs: hitInstallMs, totalMs: restoreMs + hitInstallMs },
    scope:
      'Desktop script-free frozen install, fresh isolated store per miss; alternating policy order.',
    limit:
      'Measures local install/archive CPU and disk. Excludes GitHub cache transfer and remote service time.'
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (values.output) {
    writeFileSync(resolve(values.output), json)
  }
  console.log(json)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
