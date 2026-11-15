import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { replaceCachedElevateHelpers } from './replace-cached-nsis-elevate.mjs'

const probeUnavailable = async () => ({ path: null, error: 'app-builder-lib not loadable' })

const projectRoot = resolve(import.meta.dirname, '../../../..')
const scriptPath = join(
  projectRoot,
  'config/scripts/desktop-distribution/nsis/replace-cached-nsis-elevate.mjs'
)

let scratch

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'orca elevate swap '))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function makeCache(...relativeFiles) {
  const cacheDir = join(scratch, 'Cache')
  for (const relative of relativeFiles) {
    const path = join(cacheDir, ...relative.split('/'))
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'unsigned-elevate')
  }
  mkdirSync(cacheDir, { recursive: true })
  return cacheDir
}

describe('cached elevate.exe swap covers the real electron-builder layouts', () => {
  it('replaces every cached copy when several bundles are present', async () => {
    const cacheDir = makeCache(
      'nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/elevate.exe',
      'nsis@1.2.1/nsis-bundle-3.12-k4d9x/elevate.exe'
    )
    const signed = join(scratch, 'signed-elevate.exe')
    writeFileSync(signed, 'signpath-signed-elevate')

    const { replaced } = await replaceCachedElevateHelpers({
      signedPath: signed,
      cacheDir,
      env: {},
      probe: probeUnavailable
    })

    expect(replaced).toHaveLength(2)
    for (const path of replaced) {
      expect(readFileSync(path, 'utf8')).toBe('signpath-signed-elevate')
    }
  })
})

describe('a cached elevate.exe miss is not silent', () => {
  function runScript(cacheDir, nsisDir, signedPath) {
    return spawnSync(process.execPath, [scriptPath, signedPath], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_BUILDER_CACHE: cacheDir,
        ELECTRON_BUILDER_NSIS_DIR: nsisDir
      }
    })
  }

  it('exits non-zero with an ::error:: annotation when no cached copy is found', () => {
    const cacheDir = makeCache()
    const emptyNsisDir = join(scratch, 'empty-nsis')
    mkdirSync(emptyNsisDir, { recursive: true })
    const signed = join(scratch, 'signed-elevate.exe')
    writeFileSync(signed, 'signpath-signed-elevate')

    const result = runScript(cacheDir, emptyNsisDir, signed)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::No cached elevate.exe found')
  })

  it('warns on the scan-only path so green never means the probe was skipped', () => {
    const cacheDir = makeCache('nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/elevate.exe')
    const emptyNsisDir = join(scratch, 'empty-nsis')
    mkdirSync(emptyNsisDir, { recursive: true })
    const signed = join(scratch, 'signed-elevate.exe')
    writeFileSync(signed, 'signpath-signed-elevate')

    const result = runScript(cacheDir, emptyNsisDir, signed)

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('::error::')
    expect(result.stdout).toContain('::warning::Could not ask app-builder-lib')
    expect(
      readFileSync(join(cacheDir, 'nsis-3.0.4.1', 'nsis-3.0.4.1-1mx3n', 'elevate.exe'), 'utf8')
    ).toBe('signpath-signed-elevate')
  })

  it('exits clean when the probe resolves the copy the rebuild will pack', () => {
    const cacheDir = makeCache()
    const nsisDir = join(scratch, 'nsis-bundle')
    mkdirSync(nsisDir, { recursive: true })
    writeFileSync(join(nsisDir, 'elevate.exe'), 'unsigned-elevate')
    const signed = join(scratch, 'signed-elevate.exe')
    writeFileSync(signed, 'signpath-signed-elevate')

    const result = runScript(cacheDir, nsisDir, signed)

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('::error::')
    expect(result.stdout).not.toContain('::warning::')
    expect(result.stdout).toContain('the copy app-builder-lib will pack')
    expect(readFileSync(join(nsisDir, 'elevate.exe'), 'utf8')).toBe('signpath-signed-elevate')
  })
})
