import { execFile } from 'node:child_process'
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { MobileWebPackageAssets } from '../../src/main/runtime/rpc/mobile-web-package-assets'
import { MOBILE_WEB_PACKAGE_BRIDGE_RANGE } from '../../src/shared/mobile-web/bridge-release-policy'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH } from '../../src/shared/mobile-web/markdown-editor-csp'
import { MobileWebManifestSchema } from '../../src/shared/mobile-web/manifest-contract'
import {
  MOBILE_WEB_MERMAID_FRAME_PATH,
  MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH
} from '../../src/shared/mobile-web/mermaid-frame-document'

const execFileAsync = promisify(execFile)
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
    expect(script).not.toMatch(/\beval\s*\(|\bnew\s+Function\s*\(/)
    expect(script).not.toContain('/assets/icon.hash.png')
    expect(script).toMatch(/\.\/assets\/[a-f0-9]{64}\.png/)
    expect(stylesheet).toContain(
      'button,[role="button"]{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}'
    )
    expect(document).toContain("default-src 'none'")
    expect(document).toContain(`script-src 'self' ${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH}`)
    expect(document).toContain("style-src 'self' 'unsafe-inline'")
    expect(document).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(document).not.toContain('<style')
    expect(document).toContain('maximum-scale=1,user-scalable=no')
    expect(document).toContain('viewport-fit=cover')
    expect(document).toContain("frame-src 'self' data:")
    expect(mermaidFrame).toContain(`script-src ${MOBILE_WEB_MERMAID_FRAME_SCRIPT_CSP_HASH} blob:`)
    expect(mermaidFrame).toContain("frame-ancestors 'self'")
    expect(mermaidFrame).not.toContain(MOBILE_WEB_MERMAID_FRAME_PATH)
    expect(manifest.assets).toHaveLength(5)
    expect(manifest.assets.filter((asset) => asset.role === 'document')).toHaveLength(2)
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
