import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { legacy7zaRelativePath, resolve7zaPath } from './resolve-7za-path.mjs'

const projectRoot = resolve(import.meta.dirname, '../..')

describe('7za path resolution for the Windows signing gates (#6487)', () => {
  // Why fixtures: 7zip-bin@5.2.0 ships mac/{arm64,x64}, win/{arm64,ia32,x64}
  // and linux/{arm,arm64,ia32,x64} — a `darwin/` or arch-collapsed guess
  // resolves to nothing, which is how the gate degraded silently in the first place.
  it.each([
    ['darwin', 'arm64', 'mac/arm64/7za'],
    ['darwin', 'x64', 'mac/x64/7za'],
    ['win32', 'x64', 'win/x64/7za.exe'],
    ['win32', 'ia32', 'win/ia32/7za.exe'],
    ['win32', 'arm64', 'win/arm64/7za.exe'],
    ['linux', 'x64', 'linux/x64/7za'],
    ['linux', 'arm64', 'linux/arm64/7za']
  ])('maps the %s/%s legacy layout to %s', (platform, arch, expected) => {
    expect(legacy7zaRelativePath(platform, arch).join('/')).toBe(
      `node_modules/7zip-bin/${expected}`
    )
  })

  it('prefers a real legacy binary over the downloaded toolset', async () => {
    // Only meaningful if a transitive dep reintroduces the package.
    const legacy = join(projectRoot, ...legacy7zaRelativePath())
    if (!existsSync(legacy)) {
      return
    }
    await expect(resolve7zaPath(projectRoot)).resolves.toBe(legacy)
  })

  it('resolves an executable 7za that can extract an archive', async () => {
    const path7za = await resolve7zaPath(projectRoot)
    expect(existsSync(path7za)).toBe(true)

    const scratch = mkdtempSync(join(tmpdir(), 'orca 7za resolve '))
    try {
      const payloadDir = join(scratch, 'payload')
      mkdirSync(payloadDir, { recursive: true })
      writeFileSync(join(payloadDir, 'Orca.exe'), 'not-a-real-pe')

      const archive = join(scratch, 'bundle.7z')
      const created = spawnSync(path7za, ['a', archive, payloadDir], { encoding: 'utf8' })
      expect(created.status).toBe(0)

      const outDir = join(scratch, 'out')
      const extracted = spawnSync(path7za, ['x', archive, `-o${outDir}`, '-y'], {
        encoding: 'utf8'
      })
      expect(extracted.status).toBe(0)
      expect(existsSync(join(outDir, 'payload', 'Orca.exe'))).toBe(true)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120_000)

  it('prefers an explicit ELECTRON_BUILDER_7ZIP_PATH override', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'orca 7za override '))
    const previous = process.env.ELECTRON_BUILDER_7ZIP_PATH
    try {
      const fake = join(scratch, 'my7za')
      writeFileSync(fake, '#!/bin/sh\n')
      process.env.ELECTRON_BUILDER_7ZIP_PATH = fake
      await expect(resolve7zaPath(projectRoot)).resolves.toBe(fake)
    } finally {
      if (previous === undefined) {
        delete process.env.ELECTRON_BUILDER_7ZIP_PATH
      } else {
        process.env.ELECTRON_BUILDER_7ZIP_PATH = previous
      }
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  // Why a directory and not a missing path: PowerShell's `Test-Path $7za` is true
  // for directories, so a folder-valued override would clear both the resolver's
  // check and the gate's, then fail as an opaque exec error mid-extraction.
  it('ignores an override that points at a directory', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'orca 7za dir override '))
    const previous = process.env.ELECTRON_BUILDER_7ZIP_PATH
    try {
      process.env.ELECTRON_BUILDER_7ZIP_PATH = scratch
      const resolved = await resolve7zaPath(projectRoot)
      expect(resolved).not.toBe(scratch)
      expect(statSync(resolved).isFile()).toBe(true)
    } finally {
      if (previous === undefined) {
        delete process.env.ELECTRON_BUILDER_7ZIP_PATH
      } else {
        process.env.ELECTRON_BUILDER_7ZIP_PATH = previous
      }
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120_000)

  // Why concurrency: the stdout diversion patches a process-global function. A
  // naive save/restore lets the first finisher reinstate a still-diverting stub
  // as "the original", permanently swallowing stdout for the rest of the process.
  it('restores stdout after concurrent resolutions', async () => {
    const before = process.stdout.write
    await Promise.all([
      resolve7zaPath(projectRoot),
      resolve7zaPath(projectRoot),
      resolve7zaPath(projectRoot)
    ])
    expect(process.stdout.write).toBe(before)
  }, 120_000)

  // Why a subprocess: app-builder-lib memoises the resolved toolset, so an in-process
  // assertion passes on the cached value even when a dangling override would abort a
  // cold release runner.
  it('ignores an override that points at a missing file, in a cold process', () => {
    const dangling = join(tmpdir(), 'orca-7za-does-not-exist')
    const result = spawnSync(process.execPath, ['config/scripts/resolve-7za-path.mjs'], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_BUILDER_7ZIP_PATH: dangling },
      timeout: 120_000
    })

    expect(result.stderr ?? '').not.toContain('does not exist')
    expect(result.status).toBe(0)
    const resolved = result.stdout.trim()
    expect(resolved).not.toBe(dangling)
    expect(existsSync(resolved)).toBe(true)
  }, 120_000)

  it('prints exactly one clean line the PowerShell gate can consume', () => {
    const result = spawnSync(process.execPath, ['config/scripts/resolve-7za-path.mjs'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 120_000
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(existsSync(result.stdout.trim())).toBe(true)
  }, 120_000)

  // Why a cold cache with VITEST unset: app-builder-lib prints download
  // progress to stdout, and builder-util suppresses that logging under Vitest —
  // so an inherited VITEST makes this exact failure invisible. `$7za = (node
  // ...).Trim()` would otherwise receive two lines and the gate would break on
  // any runner whose toolset cache was evicted or repaired.
  it('keeps stdout to one path even when the toolset cache is cold', () => {
    const cache = mkdtempSync(join(tmpdir(), 'orca 7za cold cache '))
    try {
      const { VITEST: _vitest, ...envWithoutVitest } = process.env
      const result = spawnSync(process.execPath, ['config/scripts/resolve-7za-path.mjs'], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...envWithoutVitest, ELECTRON_BUILDER_CACHE: cache },
        timeout: 300_000
      })

      expect(result.status).toBe(0)
      const lines = result.stdout.trimEnd().split('\n')
      expect(lines).toHaveLength(1)
      expect(existsSync(lines[0])).toBe(true)
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  }, 300_000)
})
