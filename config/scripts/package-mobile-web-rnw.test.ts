import { execFile } from 'node:child_process'
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileWebPackageAssets } from '../../src/main/runtime/rpc/mobile-web-package-assets'
import { MOBILE_WEB_PACKAGE_BRIDGE_RANGE } from '../../src/shared/mobile-web/bridge-limits'
import {
  MOBILE_WEB_EMBEDDED_DOCUMENT_PATHS,
  MobileWebManifestSchema
} from '../../src/shared/mobile-web/manifest-contract'

const execFileAsync = promisify(execFile)
// Why: root vitest must not load mobile/ sources; CI's root job has no Expo toolchain.
const [MOBILE_WEB_MARKDOWN_EDITOR_PATH, MOBILE_WEB_MERMAID_FRAME_PATH] =
  MOBILE_WEB_EMBEDDED_DOCUMENT_PATHS
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('RNW mobile web packager', () => {
  it('emits a strict content-addressed package and disables Metro runtime evaluation', async () => {
    await mkdir(path.resolve('out'), { recursive: true })
    const testRoot = await mkdtemp(path.resolve('out', 'mobile-web-rnw-packager-test-'))
    temporaryRoots.push(testRoot)
    const input = path.join(testRoot, 'input')
    const output = path.join(testRoot, 'output')
    await mkdir(path.join(input, '_expo', 'static', 'js', 'web'), { recursive: true })
    await mkdir(path.join(input, '_expo', 'static', 'css'), { recursive: true })
    await mkdir(path.join(input, 'assets'), { recursive: true })
    await writeFile(path.join(input, 'assets', 'icon.hash.png'), new Uint8Array([1, 2, 3]))
    await writeFile(
      path.join(input, '_expo', 'static', 'css', 'style.css'),
      '.icon{background-image:url("/assets/icon.hash.png")}'
    )
    await writeFile(
      path.join(input, '_expo', 'static', 'js', 'web', 'entry.js'),
      [
        "const uuid=eval('require')('node:crypto').randomUUID();",
        'function split(body){return eval(body)}',
        'function jit(){return new Function(""),!0}',
        'const icon="/assets/icon.hash.png";'
      ].join('')
    )

    await execFileAsync(process.execPath, [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      'config/scripts/package-mobile-web-rnw.mjs',
      '--input',
      input,
      '--output',
      output
    ])
    await execFileAsync(process.execPath, [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      'config/scripts/verify-mobile-web-rnw-build.mjs',
      '--root',
      output
    ])

    const manifest = MobileWebManifestSchema.parse(
      JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'))
    )
    const script = await readFile(
      path.join(output, manifest.assets.find((asset) => asset.role === 'script')!.path),
      'utf8'
    )
    const stylesheet = await readFile(
      path.join(output, manifest.assets.find((asset) => asset.role === 'style')!.path),
      'utf8'
    )
    const document = await readFile(path.join(output, 'index.html'), 'utf8')
    const mermaidFrame = await readFile(path.join(output, MOBILE_WEB_MERMAID_FRAME_PATH), 'utf8')
    const markdownEditor = await readFile(
      path.join(output, MOBILE_WEB_MARKDOWN_EDITOR_PATH),
      'utf8'
    )
    expect(script).not.toMatch(/\beval\s*\(|\bnew\s+Function\s*\(/)
    expect(script).not.toContain('/assets/icon.hash.png')
    expect(script).toMatch(/\.\/assets\/[a-f0-9]{64}\.png/)
    expect(stylesheet).toContain(
      'button,[role="button"]{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}'
    )
    expect(document).not.toContain('<style')
    expect(document).not.toContain('Content-Security-Policy')
    expect(document).toContain('maximum-scale=1,user-scalable=no')
    expect(document).toContain('viewport-fit=cover')
    // No served document may carry an inline script, or a native CSP would have to pin its hash.
    for (const served of [document, mermaidFrame, markdownEditor]) {
      expect(served).not.toMatch(/<script(?![^>]*\bsrc=)/)
      expect(served).not.toContain('sha256-')
      expect(served).not.toContain('Content-Security-Policy')
      expect(served).toMatch(/<script src="\.\/assets\/[a-f0-9]{64}\.js"/)
    }
    expect(mermaidFrame).not.toContain(MOBILE_WEB_MERMAID_FRAME_PATH)
    expect(manifest.assets).toHaveLength(8)
    expect(manifest.assets.filter((asset) => asset.role === 'document')).toHaveLength(3)
    expect(manifest.bridge).toEqual(MOBILE_WEB_PACKAGE_BRIDGE_RANGE)

    const packageAssets = new MobileWebPackageAssets({ resolveRoot: () => output })
    await expect(packageAssets.getManifest()).resolves.toMatchObject({
      manifest: { buildId: manifest.buildId, totalBytes: manifest.totalBytes }
    })
    await expect(
      packageAssets.getAssetChunk({
        buildId: manifest.buildId,
        path: manifest.entrypoint,
        offset: 0
      })
    ).resolves.toMatchObject({ buildId: manifest.buildId, path: 'index.html', offset: 0 })

    await writeFile(
      path.join(output, manifest.assets.find((asset) => asset.role === 'script')!.path),
      'tampered'
    )
    await expect(
      execFileAsync(process.execPath, [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        'config/scripts/verify-mobile-web-rnw-build.mjs',
        '--root',
        output
      ])
    ).rejects.toThrow()
  })
})
