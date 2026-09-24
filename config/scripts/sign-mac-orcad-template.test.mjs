import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const { signMacAppWithOrcadTemplate } = require('./sign-mac-orcad-template.cjs')
const { verifyPackagedOrcadTemplate } = require('./verify-packaged-orcad-template.cjs')
const roots = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-template-sign-test-'))
  roots.push(root)
  const app = join(root, 'Orca.app')
  const resources = join(app, 'Contents', 'Resources')
  const template = await writeOrcadTemplateTestFixture(resources)
  const manifestPath = join(template, 'orcad-template.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const browserName = 'agent-browser-darwin-arm64'
  const browser = join(template, 'targets', 'darwin-arm64', browserName)
  await writeFile(browser, 'unsigned-browser')
  Object.assign(manifest.targets['darwin-arm64'], {
    browserName,
    browserSha256: createHash('sha256').update('unsigned-browser').digest('hex')
  })
  await writeFile(manifestPath, JSON.stringify(manifest))
  const natives = [
    join(template, 'targets', 'darwin-arm64', 'watcher.node'),
    join(template, 'targets', 'darwin-x64', 'watcher.node'),
    browser
  ]
  const optionsForFile = vi.fn(() => ({ entitlements: '/entitlements', hardenedRuntime: true }))
  const options = {
    app,
    identity: 'release-identity',
    keychain: '/keychain',
    strictVerify: true,
    ignore: () => false,
    optionsForFile
  }
  return { app, options, optionsForFile, resources, template, manifestPath, manifest, natives }
}

async function signNativeFiles(options, input, revision = 1) {
  for (const path of input.natives) {
    expect(options.optionsForFile(path)).toEqual({
      entitlements: '/entitlements',
      hardenedRuntime: true
    })
    await writeFile(path, `signed:${revision}:${path}`)
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('macOS signing of Orca deployment templates', () => {
  it('records signed bytes before the outer seal while preserving default signing options', async () => {
    const input = await fixture()
    const sign = vi.fn(async (options) => {
      expect(options).toMatchObject({
        ...input.options,
        optionsForFile: expect.any(Function)
      })
      await signNativeFiles(options, input)
      expect(() => verifyPackagedOrcadTemplate(input.resources)).toThrow('checksum mismatch')
      options.optionsForFile(input.app)
      expect(() => verifyPackagedOrcadTemplate(input.resources)).not.toThrow()
    })
    await signMacAppWithOrcadTemplate(input.options, sign)
    expect(sign).toHaveBeenCalledOnce()
    expect(input.optionsForFile).toHaveBeenCalledWith(input.app)
    const final = JSON.parse(await readFile(input.manifestPath, 'utf8'))
    expect(final.schemaVersion).toBe(2)
    expect(final.commonSha256).toEqual(input.manifest.commonSha256)
    expect(final.targets['linux-x64-glibc']).toEqual(input.manifest.targets['linux-x64-glibc'])
    expect(final.targets['darwin-arm64'].targetSha256).toBe(
      input.manifest.targets['darwin-arm64'].targetSha256
    )
    expect(final.targets['darwin-arm64'].watcherSha256).not.toBe(
      input.manifest.targets['darwin-arm64'].watcherSha256
    )
  })

  it('refuses preexisting corruption before signing begins', async () => {
    const input = await fixture()
    await writeFile(input.natives[0], 'tampered')
    const sign = vi.fn()
    await expect(signMacAppWithOrcadTemplate(input.options, sign)).rejects.toThrow(
      'checksum mismatch'
    )
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses an ignored native payload even if another process changed its bytes', async () => {
    const input = await fixture()
    await expect(
      signMacAppWithOrcadTemplate(input.options, async (options) => {
        await writeFile(input.natives[0], 'changed-without-signing')
        options.optionsForFile(input.app)
      })
    ).rejects.toThrow('skipped an Orca runtime native payload')
  })

  it.each(['orcad.js', 'targets/linux-x64-glibc/watcher.node'])(
    'does not bless unrelated changes to %s during signing',
    async (filename) => {
      const input = await fixture()
      await expect(
        signMacAppWithOrcadTemplate(input.options, async (options) => {
          await signNativeFiles(options, input)
          await writeFile(join(input.template, ...filename.split('/')), 'unexpected-change')
          options.optionsForFile(input.app)
        })
      ).rejects.toThrow('checksum mismatch')
    }
  )

  it('refuses a replaced manifest during signing', async () => {
    const input = await fixture()
    await expect(
      signMacAppWithOrcadTemplate(input.options, async (options) => {
        await signNativeFiles(options, input)
        await writeFile(input.manifestPath, '{}')
        options.optionsForFile(input.app)
      })
    ).rejects.toThrow('manifest changed during signing')
  })

  it('fails if a signing implementation omits the final callback', async () => {
    const input = await fixture()
    await expect(signMacAppWithOrcadTemplate(input.options, async () => {})).rejects.toThrow(
      'did not finalize'
    )
  })

  it('refuses native payload changes after the outer seal', async () => {
    const input = await fixture()
    await expect(
      signMacAppWithOrcadTemplate(input.options, async (options) => {
        await signNativeFiles(options, input)
        options.optionsForFile(input.app)
        await writeFile(input.natives[0], 'after-seal-change')
      })
    ).rejects.toThrow('checksum mismatch')
  })

  it('supports the default signer retrying with new signature bytes', async () => {
    const input = await fixture()
    await signMacAppWithOrcadTemplate(input.options, async (options) => {
      for (const revision of [1, 2]) {
        await signNativeFiles(options, input, revision)
        options.optionsForFile(input.app)
      }
    })
    expect(() => verifyPackagedOrcadTemplate(input.resources)).not.toThrow()
  })

  it('connects the wrapper to macOS packaging', () => {
    const config = require('../electron-builder.config.cjs')
    expect(config.mac.sign.toString()).toContain('signMacAppWithOrcadTemplate')
  })

  it('rechecks the manifest after signing and notarization without rewriting it', async () => {
    const input = await fixture()
    const config = require('../electron-builder.config.cjs')
    const context = {
      electronPlatformName: 'darwin',
      appOutDir: dirname(input.app),
      packager: { appInfo: { productFilename: 'Orca' } }
    }
    const before = await readFile(input.manifestPath, 'utf8')
    expect(() => config.afterSign(context)).not.toThrow()
    await writeFile(input.natives[0], 'changed-after-signing')
    expect(() => config.afterSign(context)).toThrow('checksum mismatch')
    expect(await readFile(input.manifestPath, 'utf8')).toBe(before)
  })

  it.skipIf(process.platform !== 'darwin')(
    'preserves manifest verification through actual child signing and the outer app seal',
    async () => {
      const input = await fixture()
      const contents = join(input.app, 'Contents')
      await mkdir(join(contents, 'MacOS'), { recursive: true })
      await copyFile('/usr/bin/true', join(contents, 'MacOS', 'Orca'))
      await writeFile(
        join(contents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
         <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
         <plist version="1.0"><dict>
           <key>CFBundleIdentifier</key><string>test.orca.template-sign</string>
           <key>CFBundleExecutable</key><string>Orca</string>
           <key>CFBundlePackageType</key><string>APPL</string>
         </dict></plist>`
      )
      const unsignedHash = createHash('sha256')
        .update(await readFile('/usr/bin/true'))
        .digest('hex')
      for (const path of input.natives) {
        await copyFile('/usr/bin/true', path)
      }
      for (const [target, entry] of Object.entries(input.manifest.targets)) {
        if (target.startsWith('darwin-')) {
          entry.watcherSha256 = unsignedHash
          if (entry.browserName) {
            entry.browserSha256 = unsignedHash
          }
        }
      }
      await writeFile(input.manifestPath, JSON.stringify(input.manifest))
      await signMacAppWithOrcadTemplate({
        ...input.options,
        identity: '-',
        identityValidation: false,
        keychain: undefined,
        platform: 'darwin',
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: () => ({
          hardenedRuntime: false,
          entitlements: join(process.cwd(), 'resources', 'build', 'entitlements.mac.plist')
        })
      })
      expect(() => verifyPackagedOrcadTemplate(input.resources)).not.toThrow()
      const signed = JSON.parse(await readFile(input.manifestPath, 'utf8'))
      expect(signed.targets['darwin-arm64'].watcherSha256).not.toBe(unsignedHash)
    },
    60_000
  )
})
