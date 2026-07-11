import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  acquireRuntimeBuildLease,
  pruneImmutableRuntimeBuilds,
  publishRuntimeBuildPointer,
  runtimeProcessStartToken
} from './wsl-watcher-runtime-build-source.mjs'

const execFileAsync = promisify(execFile)

describe('immutable WSL runtime build retention', () => {
  it('preserves a fresh lease while its owner metadata is being published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-wsl-build-pending-lease-'))
    const output = join(root, 'out', 'wsl-watcher')
    const version = 'b'.repeat(20)
    const buildsDir = `${output}.builds`
    const build = join(buildsDir, version)
    const lease = join(buildsDir, `${version}.lease-pending`)
    try {
      await mkdir(build, { recursive: true })
      await mkdir(lease)
      await utimes(lease, new Date(99_500), new Date(99_500))

      await pruneImmutableRuntimeBuilds(output, {
        maxCompletedBuilds: 0,
        minRecentBuilds: 0,
        maxBuildAgeMs: 0,
        unknownLeaseAgeMs: 1_000,
        now: () => 100_000
      })
      expect(await readdir(buildsDir)).toEqual(
        expect.arrayContaining([version, `${version}.lease-pending`])
      )

      await pruneImmutableRuntimeBuilds(output, {
        maxCompletedBuilds: 0,
        minRecentBuilds: 0,
        maxBuildAgeMs: 0,
        unknownLeaseAgeMs: 1_000,
        now: () => 101_000
      })
      expect(await readdir(buildsDir)).not.toContain(version)
      expect(await readdir(buildsDir)).not.toContain(`${version}.lease-pending`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves current, recent, and actively leased builds while bounding completed versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-wsl-build-retention-'))
    const output = join(root, 'out', 'wsl-watcher')
    const buildsDir = `${output}.builds`
    const versions = Array.from({ length: 6 }, (_, index) =>
      (index + 1).toString(16).padStart(20, '0')
    )
    try {
      await mkdir(buildsDir, { recursive: true })
      for (const [index, version] of versions.entries()) {
        const build = join(buildsDir, version)
        await mkdir(build)
        await utimes(build, new Date(index * 1_000), new Date(index * 1_000))
      }
      const currentVersion = versions[1]
      await publishRuntimeBuildPointer(
        output,
        join(buildsDir, currentVersion),
        { bundleVersion: currentVersion },
        'pointer'
      )
      const leasedVersion = versions[0]
      const lease = await acquireRuntimeBuildLease(join(buildsDir, leasedVersion), {
        createToken: () => 'active'
      })

      await pruneImmutableRuntimeBuilds(output, {
        maxCompletedBuilds: 2,
        minRecentBuilds: 1,
        maxBuildAgeMs: 0,
        now: () => 100_000,
        ownerIsAlive: () => true
      })

      expect(
        (await readdir(buildsDir)).filter((name) => /^[a-f0-9]{20}$/.test(name)).sort()
      ).toEqual([currentVersion, leasedVersion, versions.at(-1)].sort())
      await rm(lease, { recursive: true, force: true })
      await pruneImmutableRuntimeBuilds(output, {
        maxCompletedBuilds: 2,
        minRecentBuilds: 1,
        maxBuildAgeMs: 0,
        now: () => 100_000
      })
      expect(await readdir(buildsDir)).not.toContain(leasedVersion)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a parent-owned lease active after the preparation child exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-wsl-build-parent-lease-'))
    const output = join(root, 'out', 'wsl-watcher')
    const version = 'a'.repeat(20)
    const build = join(`${output}.builds`, version)
    const parentStartToken = await runtimeProcessStartToken(process.pid)
    const moduleUrl = new URL('./wsl-watcher-runtime-build-source.mjs', import.meta.url).href
    try {
      await mkdir(build, { recursive: true })
      const childScript = `
        import { acquireRuntimeBuildLease } from ${JSON.stringify(moduleUrl)};
        await acquireRuntimeBuildLease(${JSON.stringify(build)}, {
          createToken: () => 'child-created',
          ownerProcessId: ${process.pid},
          ownerProcessStartToken: ${JSON.stringify(parentStartToken)}
        });
      `
      await execFileAsync(process.execPath, ['--input-type=module', '--eval', childScript], {
        timeout: 10_000,
        windowsHide: true
      })

      await pruneImmutableRuntimeBuilds(output, {
        maxCompletedBuilds: 0,
        minRecentBuilds: 0,
        maxBuildAgeMs: 0
      })
      expect(await readdir(`${output}.builds`)).toContain(version)
      await expect(
        acquireRuntimeBuildLease(build, {
          ownerProcessId: process.pid,
          ownerProcessStartToken: 'wrong-process-start-token'
        })
      ).rejects.toThrow('Cannot verify WSL runtime build lease owner')

      await rm(join(`${output}.builds`, `${version}.lease-child-created`), {
        recursive: true,
        force: true
      })
      await pruneImmutableRuntimeBuilds(output, {
        maxCompletedBuilds: 0,
        minRecentBuilds: 0,
        maxBuildAgeMs: 0
      })
      expect(await readdir(`${output}.builds`)).not.toContain(version)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
