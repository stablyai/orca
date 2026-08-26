import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { stampPackagedCliVersion } = require('./stamp-packaged-cli-version.cjs')

describe('stampPackagedCliVersion', () => {
  it('stamps the effective Electron Builder version into CLI metadata', () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), 'orca-packaged-cli-version-'))
    try {
      const metadataPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'package.json')
      mkdirSync(join(resourcesDir, 'app.asar.unpacked', 'out'), { recursive: true })
      writeFileSync(
        metadataPath,
        JSON.stringify({ name: 'orca-compiled-output', type: 'commonjs', version: '1.4.178' }),
        'utf8'
      )

      expect(stampPackagedCliVersion(resourcesDir, '1.4.178-local.42')).toBe(metadataPath)
      expect(JSON.parse(readFileSync(metadataPath, 'utf8')).version).toBe('1.4.178-local.42')
    } finally {
      rmSync(resourcesDir, { recursive: true, force: true })
    }
  })
})
