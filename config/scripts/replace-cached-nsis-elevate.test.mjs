import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import {
  findCachedElevatePaths,
  replaceCachedElevateHelpers,
  resolveElectronBuilderCacheDir,
  summarizeSwap
} from './replace-cached-nsis-elevate.mjs'

// The probe is app-builder-lib asking itself where the packed elevate.exe lives; injected
// here so no test needs the network or a warm toolset cache.
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
  // Why these exact shapes: `downloadBuilderToolset` unpacks to
  // `<cache>/<releaseName>/<archive basename>-<url hash>/`, and `releaseName` is
  // `nsis-3.0.4.1` on the legacy bundle (`getBinFromUrl`) and `nsis@<toolset>` on the
  // unified bundle. The release workflow searched `<cache>/nsis`, which matches none of
  // them. `customNsisBinary` is deliberately absent — see the probe suite below.
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

  // `nsis-resources-3.4.1` matches the release-dir pattern and is scanned. Documented
  // rather than excluded: `getLegacyNsisResourcesBin` ships plugins, never an elevate.exe,
  // so the over-match costs one cheap directory read and nothing else. Narrowing the
  // pattern to exclude it would be a guess about a name app-builder-lib owns.
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

  // The rebuild picks one bundle, and nothing outside app-builder-lib knows which.
  // Replacing every cached copy is the deliberate answer to that ambiguity.
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

  it('resolves the cache root the same way app-builder-lib does', () => {
    expect(
      resolveElectronBuilderCacheDir({
        env: { LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local' },
        platform: 'win32'
      })
    ).toBe(join('C:\\Users\\runneradmin\\AppData\\Local', 'electron-builder', 'Cache'))
    expect(resolveElectronBuilderCacheDir({ env: {}, platform: 'darwin', home: '/Users/a' })).toBe(
      join('/Users/a', 'Library', 'Caches', 'electron-builder')
    )
    expect(resolveElectronBuilderCacheDir({ env: { ELECTRON_BUILDER_CACHE: '/mnt/cache' } })).toBe(
      '/mnt/cache'
    )
  })

  // Proof against the layout actually on disk, not just the fixtures. Cross-checked
  // against an independent unbounded walk so a search that scopes itself wrongly
  // cannot pass by finding nothing — which is exactly how the inline path passed.
  // Skipped only where no NSIS bundle has been downloaded into the cache yet.
  it('finds every elevate.exe the real electron-builder cache holds', (ctx) => {
    const cacheDir = resolveElectronBuilderCacheDir()
    if (!existsSync(cacheDir)) {
      // Reported as skipped, never as passed: this is the one test that checks the scan
      // against a layout nobody wrote down, and a silent no-op here is the suite
      // confirming itself. The Linux unit-test job has no electron-builder cache.
      ctx.skip()
      return
    }
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          return walk(path)
        }
        return entry.name.toLowerCase() === 'elevate.exe' ? [path] : []
      })
    const onDisk = walk(cacheDir)
    if (onDisk.length === 0) {
      ctx.skip()
      return
    }
    expect(findCachedElevatePaths(cacheDir, { env: {} }).sort()).toEqual(onDisk.sort())
  })
})

describe('the probe, not the scan, decides whether the swap worked', () => {
  // Why the probe is load-bearing: `getBinFromCustomLoc` passes `nsis-<version>` to `getBin`
  // as its in-process promise key only — the extract dir is named for the custom URL's parent
  // segment, so a customNsisBinary bundle can sit outside `nsis*` entirely.
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

  // The shape that reproduced the hole: release-cut.yml restores the toolset cache with
  // `restore-keys: electron-builder-win-`, so a stale release directory survives a lockfile
  // change. Replacing that stale copy satisfies `replaced.length > 0` on its own while the
  // bundle the rebuild packs sits in a directory the scan never matches.
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

    // The scan rewrote only the stale copy; the one that would be packed is untouched.
    expect(result.replaced).toEqual([join(cacheDir, ...stale.split('/'))])
    expect(readFileSync(join(cacheDir, ...packed.split('/')), 'utf8')).toBe('unsigned-elevate')

    // So the run must not look clean.
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
  // ELECTRON_BUILDER_NSIS_DIR short-circuits app-builder-lib's own resolution before
  // any download, so the probe fails offline instead of fetching the NSIS bundle.
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

  // The healthy release-job path: app-builder-lib answers, so the copy it will pack is the
  // one that gets replaced and there is nothing to warn about.
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

describe('release-cut.yml swaps the cached elevate.exe through the resolver', () => {
  function swapStep() {
    const workflow = parse(
      readFileSync(join(projectRoot, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const step = workflow.jobs.build.steps.find(
      (candidate) => candidate.name === 'Replace cached elevate.exe with the signed copy'
    )
    expect(step).toBeDefined()
    return step
  }

  it('delegates the cache lookup to the script instead of an inline path', () => {
    const step = swapStep()
    expect(step.run).toContain('node config/scripts/replace-cached-nsis-elevate.mjs $signed')
    // The hardcoded miss that shipped v1.4.193/v1.4.194 unsigned.
    expect(step.run).not.toContain('electron-builder\\Cache\\nsis')
    expect(step.run).not.toContain('-ErrorAction SilentlyContinue')
  })

  it('fails the step when the swap reports a miss', () => {
    const step = swapStep()
    // Matched as an executed statement: downgrading this to a Write-Host restores
    // the silent fail-open that let the unsigned helper ship.
    expect(step.run).toMatch(/if \(\$LASTEXITCODE -ne 0\) \{/)
    expect(step.run).toMatch(/^\s*throw \$message\s*$/m)
    expect(step.run).toContain('GITHUB_STEP_SUMMARY')
  })

  // Why kept: windows-signing-rehearsal.yml shares the electron-builder-win-<hash>
  // cache key, so dropping this guard would let a test certificate reach a release cache.
  it('still refuses to stage anything but a SignPath-signed helper', () => {
    const step = swapStep()
    expect(step.run).toContain("$signature.Status -ne 'Valid'")
    expect(step.run).toContain("$subject -notlike '*CN=SignPath Foundation*'")
  })

  // The inner-signing chain stays fail-open: a loud red step, not an unbuildable release.
  it('keeps the step unable to fail the release job', () => {
    expect(swapStep()['continue-on-error']).toBe(true)
  })
})
