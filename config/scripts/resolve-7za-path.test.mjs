import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { legacy7zaRelativePath, resolve7zaPath } from './resolve-7za-path.mjs'

const projectRoot = resolve(import.meta.dirname, '../..')

describe('7za path resolution for the Windows signing gates (#6487)', () => {
  // Match upstream mac/win/linux architecture dirs; darwin/ or collapsed-arch guesses silently fail to resolve.
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

  it('prefers an existing legacy file over the downloaded toolset', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'orca 7za legacy '))
    const previous = process.env.ELECTRON_BUILDER_7ZIP_PATH
    try {
      delete process.env.ELECTRON_BUILDER_7ZIP_PATH
      const legacy = join(scratch, ...legacy7zaRelativePath())
      mkdirSync(dirname(legacy), { recursive: true })
      writeFileSync(legacy, 'legacy binary fixture')
      await expect(resolve7zaPath(scratch)).resolves.toBe(legacy)
    } finally {
      if (previous === undefined) {
        delete process.env.ELECTRON_BUILDER_7ZIP_PATH
      } else {
        process.env.ELECTRON_BUILDER_7ZIP_PATH = previous
      }
      rmSync(scratch, { recursive: true, force: true })
    }
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

  // Use directory override: Test-Path accepts it, masking bad resolver validation until extraction fails.
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

  // Overlap calls to global stdout patch; naive save/restore can permanently restore another caller’s diverting stub.
  it('restores stdout after concurrent resolutions', async () => {
    const before = process.stdout.write
    await Promise.all([
      resolve7zaPath(projectRoot),
      resolve7zaPath(projectRoot),
      resolve7zaPath(projectRoot)
    ])
    expect(process.stdout.write).toBe(before)
  }, 120_000)

  // Use fresh subprocess: app-builder-lib memoizes toolset, hiding dangling-override failures in warm process.
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

  // Unset VITEST with cold cache: builder-util suppresses download logs in tests, hiding multiline stdout that breaks PowerShell path capture.
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
