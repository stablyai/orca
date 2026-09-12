import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildProfileLifetimeLock } from './build-profile-lifetime-lock.mjs'

test('stages only a successful native build and cleans its owned build directory', () => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'orca-profile-lock-output-'))
  let buildDirectory
  let verified = false
  try {
    const artifact = buildProfileLifetimeLock({
      outputRoot,
      run(spec) {
        buildDirectory = spec.cwd
        assert.equal(spec.env.ORCA_BACKGROUND_LAUNCH, '1')
        assert.ok(existsSync(join(spec.cwd, 'binding.gyp')))
        const release = join(spec.cwd, 'build', 'Release')
        mkdirSync(release, { recursive: true })
        writeFileSync(join(release, 'profile-lifetime-lock.node'), 'fixture')
        return { code: 0 }
      },
      verifyFloor(directory, options) {
        assert.equal(directory, join(buildDirectory, 'build', 'Release'))
        assert.equal(options.targetArch, process.arch)
        verified = true
      }
    })
    assert.equal(readFileSync(artifact, 'utf8'), 'fixture')
    assert.equal(verified, process.platform === 'linux')
    assert.equal(existsSync(buildDirectory), false)
  } finally {
    rmSync(outputRoot, { recursive: true, force: true })
  }
})

test('failed compiler is not published and temporary inputs are cleaned', () => {
  let buildDirectory
  assert.throws(
    () =>
      buildProfileLifetimeLock({
        run(spec) {
          buildDirectory = spec.cwd
          return { code: 1, stderr: 'compiler rejected source' }
        }
      }),
    /compiler rejected source/
  )
  assert.equal(existsSync(buildDirectory), false)
})

test('refuses a mislabeled cross-host build before spawning', () => {
  assert.throws(
    () =>
      buildProfileLifetimeLock({
        arch: 'unsupported',
        run() {
          assert.fail('must not spawn')
        }
      }),
    /target platform and architecture/
  )
})
