import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildMobileWebBundle,
  computeMobileWebBundleBuildId,
  isDirectInvocation,
  serializeMobileWebBundleAssets
} from './build-mobile-web-bundle.mjs'
import {
  MOBILE_WEB_BUNDLE_PHASE_A_MAX_ASSETS,
  MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES,
  assertNoCarriageReturnsInSource
} from './verify-mobile-web-bundle.mjs'

async function buildIntoScratch() {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-build-'))
  const bundleDir = join(scratch, 'mobile-web')
  const { manifest } = await buildMobileWebBundle({ outDir: bundleDir })
  return { scratch, bundleDir, manifest }
}

describe('buildMobileWebBundle', () => {
  it('emits a content-addressed bundle whose only stable name is the entrypoint', async () => {
    const { scratch, bundleDir, manifest } = await buildIntoScratch()
    try {
      const root = await readdir(bundleDir)
      expect(root.sort()).toEqual(['assets', 'index.html', 'manifest.json'])
      for (const name of await readdir(join(bundleDir, 'assets'))) {
        const [digest, extension] = name.split('.')
        expect(digest).toMatch(/^[0-9a-f]{64}$/)
        const bytes = await readFile(join(bundleDir, 'assets', name))
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest)
        expect(extension).toMatch(/^(js|css|png)$/)
      }
      const html = await readFile(join(bundleDir, 'index.html'), 'utf8')
      for (const asset of manifest.assets) {
        if (asset.path !== 'index.html') {
          expect(html).toContain(asset.path)
        }
      }
      expect(html).not.toContain('__ORCA_')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('carries every manifest field the Phase A contract names', async () => {
    const { scratch, manifest } = await buildIntoScratch()
    try {
      expect(Object.keys(manifest)).toEqual([
        'schemaVersion',
        'buildId',
        'desktopVersion',
        'minCompatibleRuntimeProtocolVersion',
        'runtimeProtocolVersion',
        'entrypoint',
        'totalBytes',
        'assets',
        'routes'
      ])
      expect(manifest.schemaVersion).toBe(1)
      expect(manifest.entrypoint).toBe('index.html')
      // The bootstrap bundle carries no route tree, so a shell reading this one finds no screen
      // listed and renders every route natively.
      expect(manifest.routes).toEqual([])
      const packageJson = JSON.parse(
        await readFile(new URL('../../package.json', import.meta.url), 'utf8')
      )
      expect(manifest.desktopVersion).toBe(packageJson.version)
      const protocolSource = await readFile(
        new URL('../../src/shared/protocol-version.ts', import.meta.url),
        'utf8'
      )
      expect(protocolSource).toContain(
        `export const RUNTIME_PROTOCOL_VERSION = ${String(manifest.runtimeProtocolVersion)}`
      )
      expect(protocolSource).toContain(
        `export const MIN_COMPATIBLE_RUNTIME_SERVER_VERSION = ${String(manifest.minCompatibleRuntimeProtocolVersion)}`
      )
      expect(manifest.totalBytes).toBe(
        manifest.assets.reduce((total, asset) => total + asset.byteLength, 0)
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('produces the same buildId from two independent builds', async () => {
    const first = await buildIntoScratch()
    const second = await buildIntoScratch()
    try {
      expect(second.manifest.buildId).toBe(first.manifest.buildId)
      expect(second.manifest).toEqual(first.manifest)
    } finally {
      await rm(first.scratch, { recursive: true, force: true })
      await rm(second.scratch, { recursive: true, force: true })
    }
  })

  it('embeds no absolute path from the machine that built it', async () => {
    const { scratch, bundleDir } = await buildIntoScratch()
    try {
      const names = [
        'index.html',
        'manifest.json',
        ...(await readdir(join(bundleDir, 'assets'))).map((name) => join('assets', name))
      ]
      for (const name of names) {
        const text = (await readFile(join(bundleDir, name))).toString('latin1')
        expect(text).not.toContain(scratch)
        expect(text).not.toContain(process.cwd())
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('stays inside the Phase A budget', async () => {
    const { scratch, manifest } = await buildIntoScratch()
    try {
      expect(manifest.assets.length).toBeLessThanOrEqual(MOBILE_WEB_BUNDLE_PHASE_A_MAX_ASSETS)
      expect(manifest.totalBytes).toBeLessThanOrEqual(MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

describe('computeMobileWebBundleBuildId', () => {
  const assets = [
    { path: 'index.html', sha256: 'a'.repeat(64), byteLength: 3, contentType: 'text/html' },
    { path: 'assets/b.js', sha256: 'b'.repeat(64), byteLength: 5, contentType: 'text/javascript' }
  ]

  it('sorts by path, so input order cannot change the id', () => {
    expect(computeMobileWebBundleBuildId(assets.toReversed())).toBe(
      computeMobileWebBundleBuildId(assets)
    )
  })

  it('serializes a fixed key order regardless of the input object key order', () => {
    const reordered = assets.map(({ contentType, byteLength, sha256, path }) => ({
      contentType,
      byteLength,
      sha256,
      path
    }))
    expect(serializeMobileWebBundleAssets(reordered)).toBe(serializeMobileWebBundleAssets(assets))
  })

  it('changes when any hashed field changes', () => {
    const baseline = computeMobileWebBundleBuildId(assets)
    for (const field of ['sha256', 'byteLength', 'contentType', 'path']) {
      const mutated = assets.map((asset, index) =>
        index === 0 ? { ...asset, [field]: field === 'byteLength' ? 4 : `${asset[field]}x` } : asset
      )
      expect(computeMobileWebBundleBuildId(mutated)).not.toBe(baseline)
    }
  })
})

describe('isDirectInvocation', () => {
  const thisFile = import.meta.filename

  it('matches the path this module was loaded from', () => {
    expect(isDirectInvocation(import.meta.url, thisFile)).toBe(true)
  })

  it('does not match a different script', () => {
    expect(isDirectInvocation(import.meta.url, join(thisFile, '..', 'other.mjs'))).toBe(false)
  })

  it('tolerates an absent argv[1]', () => {
    expect(isDirectInvocation(import.meta.url, undefined)).toBe(false)
    expect(isDirectInvocation(import.meta.url, '')).toBe(false)
  })

  // Why an injected converter: a win32 path cannot be exercised through node:url's pathToFileURL
  // on a posix runner, and CI is ubuntu.
  const toWin32FileUrl = (windowsPath) => new URL(`file:///${windowsPath.replaceAll('\\', '/')}`)

  it('matches a Windows entry path, which the file:// template form never does', () => {
    const scriptPath = 'C:\\orca\\config\\scripts\\build-mobile-web-bundle.mjs'
    const moduleUrl = 'file:///C:/orca/config/scripts/build-mobile-web-bundle.mjs'
    const keepAsIs = (path) => path
    expect(
      isDirectInvocation(moduleUrl, scriptPath, {
        toFileUrl: toWin32FileUrl,
        realpath: keepAsIs
      })
    ).toBe(true)
    // The regression this guards: `file://${argv[1]}` yields file://C:\orca\... on Windows,
    // so the builder exited 0 having written nothing and packaging failed downstream.
    expect(`file://${scriptPath}`).not.toBe(moduleUrl)
  })

  it('is not written with the file:// template form', async () => {
    const source = await readFile(new URL('./build-mobile-web-bundle.mjs', import.meta.url), 'utf8')
    expect(source).not.toMatch(/file:\/\/\$\{process\.argv\[1\]\}/)
    expect(source).toContain('pathToFileURL')
  })
})

describe('mobile web source line endings', () => {
  it('accepts the committed source tree', async () => {
    await expect(assertNoCarriageReturnsInSource()).resolves.toBeUndefined()
  })

  it('rejects a CRLF source file, because CRLF changes every asset hash and the buildId', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-eol-'))
    try {
      await writeFile(join(scratch, 'bootstrap.ts'), 'const a = 1\r\nconst b = 2\r\n', 'utf8')
      await expect(assertNoCarriageReturnsInSource(scratch)).rejects.toThrow(
        /CRLF in mobile web source/
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('pins eol=lf for every committed text source and -text for the binary', () => {
    const files = execFileSync('git', ['ls-files', 'src/mobile-web'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    expect(files.length).toBeGreaterThanOrEqual(4)
    for (const file of files) {
      const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', file], {
        encoding: 'utf8'
      })
      if (file.endsWith('.png')) {
        expect(attributes).toContain('text: unset')
      } else {
        expect(attributes).toContain('eol: lf')
      }
    }
  })
})

describe('running the builder through a symlink', () => {
  // Node resolves symlinks in import.meta.url but not in argv[1]. Before the guard realpath'd the
  // entry path, `node /tmp/<link>` compared /tmp against /private/tmp and the builder exited 0
  // having written nothing — a green packaging job with no bundle in it.
  it('still recognises the entry module', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-link-'))
    try {
      const builderUrl = new URL('./build-mobile-web-bundle.mjs', import.meta.url).href
      const real = join(scratch, 'entry.mjs')
      await writeFile(
        real,
        `import { isDirectInvocation } from ${JSON.stringify(builderUrl)}\n` +
          'process.stdout.write(String(isDirectInvocation(import.meta.url, process.argv[1])))\n',
        'utf8'
      )
      const link = join(scratch, 'entry-link.mjs')
      await symlink(real, link)
      expect(execFileSync(process.execPath, [link], { encoding: 'utf8' })).toBe('true')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
