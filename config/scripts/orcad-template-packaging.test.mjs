import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTree } from '../../src/shared/windows-transient-lock-removal.ts'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'

const require = createRequire(import.meta.url)
const config = require('../electron-builder.config.cjs')
const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

describe('desktop managed server template', () => {
  it.each(['mac', 'linux', 'win'])('ships the template outside the %s app archive', (platform) => {
    expect(config[platform].extraResources).toContainEqual({
      from: 'out/orcad-template',
      to: 'orcad-template'
    })
    expect(config.files).toContain('!out/orcad-template{,/**/*}')
  })

  it.each(['build:desktop', 'build:release', 'build:release:parallel'])(
    '%s builds the template after the app outputs',
    (script) => {
      const steps = scripts[script].split(' && ')
      expect(steps.filter((step) => step === 'pnpm run build:orcad-template')).toHaveLength(1)
      expect(steps.indexOf('pnpm run build:orcad-template')).toBeGreaterThan(
        steps.indexOf('pnpm run build:mobile-web')
      )
    }
  )

  it.each(['missing', 'corrupt'])('fails packaging with a %s template', async (state) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-template-packaging-'))
    try {
      const resourcesDir = join(root, 'resources')
      await mkdir(resourcesDir)
      if (state === 'corrupt') {
        const templateDir = await writeOrcadTemplateTestFixture(resourcesDir)
        await writeFile(join(templateDir, 'orcad.js'), 'corrupt')
      }
      await expect(
        config.afterPack({
          appOutDir: root,
          electronPlatformName: 'win32',
          packager: { appInfo: { version: '9.9.9' } }
        })
      ).rejects.toThrow(state === 'missing' ? /orcad-template/ : /orcad.js checksum mismatch/)
    } finally {
      await removeTree(root)
    }
  })
})
