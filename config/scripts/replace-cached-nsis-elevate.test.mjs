import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  findCachedElevatePaths,
  replaceCachedElevateHelpers,
  summarizeSwap
} from './replace-cached-nsis-elevate.mjs'

// Inject app-builder-lib’s packed-path probe so tests need neither network nor warm toolset cache.
const probeFound = (path) => async () => ({ path, error: null })
const probeUnavailable = async () => ({ path: null, error: 'app-builder-lib not loadable' })

const projectRoot = resolve(import.meta.dirname, '../..')
const scriptPath = join(projectRoot, 'config/scripts/replace-cached-nsis-elevate.mjs')

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
  // Model real <releaseName>/<archive>-<url hash> legacy/unified layouts; old <cache>/nsis matched neither. Custom layout is covered by probe tests.
  it.each([
    ['legacy bundle', 'nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/elevate.exe'],
    ['unified bundle', 'nsis@1.2.1/nsis-bundle-3.12-k4d9x/elevate.exe'],
    ['bare nsis release dir', 'nsis/nsis-3.0.4.1/elevate.exe']
  ])('finds the cached helper in the %s layout', (_label, relative) => {
    const cacheDir = makeCache(relative)
    expect(findCachedElevatePaths(cacheDir, { env: {} })).toEqual([
      join(cacheDir, ...relative.split('/'))
    ])
  })

  it('leaves other toolsets and the raw download dir alone', () => {
    const cacheDir = makeCache(
      'winCodeSign/winCodeSign-2.6.0-abc12/elevate.exe',
      'downloads/nsis/elevate.exe'
    )
    expect(findCachedElevatePaths(cacheDir, { env: {} })).toEqual([])
  })

  // Allow nsis-resources overmatch: it ships plugins without elevate.exe and costs one cheap read; guessing narrower upstream naming is brittle.
  it('scans the resources bundle too, which ships no helper to find', () => {
    expect(
      findCachedElevatePaths(makeCache('nsis-resources-3.4.1/plugins/x86-unicode/nsProcess.dll'), {
        env: {}
      })
    ).toEqual([])

    const planted = 'nsis-resources-3.4.1/nsis-resources-3.4.1-p8w1z/elevate.exe'
    const cacheDir = makeCache(planted)
    expect(findCachedElevatePaths(cacheDir, { env: {} })).toEqual([
      join(cacheDir, ...planted.split('/'))
    ])
  })

  // Replace all cached copies because only app-builder-lib knows which one repack chooses.
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

  it('covers the ELECTRON_BUILDER_NSIS_DIR override copy', () => {
    const overrideDir = join(scratch, 'nsis-override')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'elevate.exe'), 'unsigned-elevate')
    const cacheDir = makeCache()

    expect(
      findCachedElevatePaths(cacheDir, { env: { ELECTRON_BUILDER_NSIS_DIR: overrideDir } })
    ).toEqual([join(overrideDir, 'elevate.exe')])
  })

  // Compare real cache scan against independent unbounded walk to catch vacuous empty matches; skip only if no bundle is cached.
})

describe('the probe, not the scan, decides whether the swap worked', () => {
  // customNsisBinary uses nsis-version only as memoization key; URL-parent extraction directory can bypass nsis* scan.
  it('covers a custom bundle the directory scan cannot match', async () => {
    const relative = 'orca-nsis-mirror/nsis-custom-3.11-0zqp2/elevate.exe'
    const cacheDir = makeCache(relative)
    const packed = join(cacheDir, ...relative.split('/'))
    const signed = join(scratch, 'signed-elevate.exe')
    writeFileSync(signed, 'signpath-signed-elevate')

    expect(findCachedElevatePaths(cacheDir, { env: {} })).toEqual([])

    const result = await replaceCachedElevateHelpers({
      signedPath: signed,
      cacheDir,
      env: {},
      probe: probeFound(packed)
    })

    expect(result.toolsetReplaced).toBe(true)
    expect(readFileSync(packed, 'utf8')).toBe('signpath-signed-elevate')
    expect(summarizeSwap(result)).toEqual({ annotations: [], exitCode: 0 })
  })

  // Prefix-restored stale release can satisfy replaced.length while authoritative packed bundle sits outside scan; model both copies.
  it('does not call a stale directory a success when the packed bundle is unmatched', async () => {
    const stale = 'nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/elevate.exe'
    const packed = 'builder-nsis@4.0.0/nsis-bundle-4.0-k4d9x/elevate.exe'
    const cacheDir = makeCache(stale, packed)
    const signed = join(scratch, 'signed-elevate.exe')
    writeFileSync(signed, 'signpath-signed-elevate')

    const result = await replaceCachedElevateHelpers({
      signedPath: signed,
      cacheDir,
      env: {},
      probe: probeUnavailable
    })

    expect(result.replaced).toEqual([join(cacheDir, ...stale.split('/'))])
    expect(readFileSync(join(cacheDir, ...packed.split('/')), 'utf8')).toBe('unsigned-elevate')

    const { annotations, exitCode } = summarizeSwap(result)
    expect(exitCode).toBe(0)
    expect(annotations).toHaveLength(1)
    expect(annotations[0].level).toBe('warning')
    expect(annotations[0].message).toContain('Could not ask app-builder-lib')
  })

  it('fails when the probe names a copy that could not be replaced', () => {
    const summary = summarizeSwap({
      replaced: ['C:/cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/elevate.exe'],
      cacheDir: 'C:/cache',
      toolsetPath: 'C:/cache/nsis@2.0.0/nsis-bundle-4.0-k4d9x/elevate.exe',
      toolsetError: null,
      toolsetReplaced: false
    })

    expect(summary.exitCode).toBe(1)
    expect(summary.annotations[0].level).toBe('error')
    expect(summary.annotations[0].message).toContain('will pack')
  })

  it('fails when nothing at all was replaced', () => {
    const summary = summarizeSwap({
      replaced: [],
      cacheDir: 'C:/cache',
      toolsetPath: null,
      toolsetError: 'app-builder-lib not loadable',
      toolsetReplaced: false
    })

    expect(summary.exitCode).toBe(1)
    expect(summary.annotations[0].level).toBe('error')
    expect(summary.annotations[0].message).toContain('No cached elevate.exe found')
  })
})

describe('a cached elevate.exe miss is not silent', () => {
  // Override short-circuits downloads, so authoritative probe fails offline instead of fetching a toolset.
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

  // Healthy release path replaces exact copy returned by app-builder-lib, requiring no warning.
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
