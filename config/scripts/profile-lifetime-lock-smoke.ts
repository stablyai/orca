import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcessSync } from '../../src/shared/child-process/run-process'
import type { ProfileLifetimeLockBinding } from '../../src/main/ssh/profile-lifetime-lock'

const [addonArgument, ...contenders] = process.argv.slice(2)
if (!addonArgument || !contenders.length) {
  throw new Error('Expected addon path and one or more contender runtime paths')
}
const addon = resolve(addonArgument)
const binding: ProfileLifetimeLockBinding = createRequire(import.meta.url)(addon)
const directory = mkdtempSync(join(tmpdir(), 'orca-profile-lock-smoke-'))
const path = join(directory, 'profile-lifetime.lock')
const probe = (runtime: string, expected: string) => {
  const source = `
    const binding = require(${JSON.stringify(addon)});
    try {
      const token = binding.acquire(${JSON.stringify(path)});
      binding.assertCurrent(token);
      binding.release(token);
      process.stdout.write('acquired');
    } catch (error) {
      if (error.code !== 'profile_lock_busy') throw error;
      process.stdout.write('busy');
    }
  `
  const result = runProcessSync({
    program: runtime,
    args: ['-e', source],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 10_000
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, expected)
}

let token: object | undefined
try {
  assert.throws(() => binding.acquire(directory), { code: 'profile_lock_unavailable' })
  assert.throws(() => binding.acquire(`${path}\0ignored`), { code: 'profile_lock_unavailable' })
  for (const foreign of [null, undefined, 1, 'token', {}, []]) {
    assert.throws(() => binding.release(foreign as object), { code: 'profile_lock_unavailable' })
    assert.throws(() => binding.assertCurrent(foreign as object), {
      code: 'profile_lock_unavailable'
    })
  }
  for (const contender of contenders) {
    token = binding.acquire(path)
    binding.assertCurrent(token)
    probe(contender, 'busy')
    closeSync(openSync(path, 'r'))
    binding.assertCurrent(token)
    probe(contender, 'busy')
    binding.release(token)
    token = undefined
    probe(contender, 'acquired')
  }
  if (process.platform !== 'win32') {
    token = binding.acquire(path)
    renameSync(path, `${path}.retained`)
    writeFileSync(path, '')
    assert.throws(() => binding.assertCurrent(token!), { code: 'profile_lock_identity_changed' })
    binding.release(token)
    token = undefined
  }
  console.log(
    JSON.stringify({
      owner: process.execPath,
      platform: process.platform,
      arch: process.arch,
      contenders,
      result: 'passed'
    })
  )
} finally {
  if (token) {
    binding.release(token)
  }
  rmSync(directory, { recursive: true, force: true })
}
