import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

for (const previousBoot of ['old-boot', 'current-boot', '']) {
  test(
    `serve resets inherited display artifacts only across a recorded boot: ${previousBoot || 'first boot'}`,
    { skip: process.platform === 'win32' },
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-serve-boot-'))
      try {
        const control = join(directory, 'control')
        const profile = join(directory, 'profile')
        mkdirSync(control)
        mkdirSync(profile)
        writeFileSync(join(control, 'boot-id'), previousBoot)
        const artifacts = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].map((name) =>
          join(profile, name)
        )
        artifacts.push(join(directory, 'X99-lock'), join(directory, 'X99-socket'))
        for (const path of artifacts) {
          writeFileSync(path, String(process.pid))
        }
        const source = readFileSync(new URL('remote-serve.sh', import.meta.url), 'utf8')
        const boundary = source.indexOf(`printf '%s' "$boot_id"`)
        assert.ok(boundary > 0)
        const script = source
          .slice(0, boundary)
          .replaceAll('/vercel/orca-control', control)
          .replaceAll('/vercel/orca-profile', profile)
          .replaceAll('/tmp/.X99-lock', join(directory, 'X99-lock'))
          .replaceAll('/tmp/.X11-unix/X99', join(directory, 'X99-socket'))
          .replace('cat /proc/sys/kernel/random/boot_id', 'printf current-boot')
        const result = spawnSync('bash', ['-c', `flock() { return 0; }\n${script}`], {
          encoding: 'utf8'
        })
        assert.equal(result.status, 0, result.stderr)
        for (const path of artifacts) {
          assert.equal(existsSync(path), previousBoot !== 'old-boot', path)
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )
}
