import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')

describe('electron-builder speech resources', () => {
  it('excludes bundled variants and keeps one target resource per platform', () => {
    expect(electronBuilderConfig.files).toContain('!node_modules/sherpa-onnx*{,/**/*}')
    expect(electronBuilderConfig.asarUnpack).not.toContain('node_modules/sherpa-onnx*/**')

    for (const [platform, packagePath] of [
      ['mac', 'node_modules/sherpa-onnx-darwin-${arch}'],
      ['linux', 'node_modules/sherpa-onnx-linux-${arch}'],
      ['win', 'node_modules/sherpa-onnx-win-x64']
    ]) {
      const speechResources = electronBuilderConfig[platform].extraResources.filter(
        (resource) =>
          typeof resource.to === 'string' && resource.to.startsWith('node_modules/sherpa-onnx')
      )
      expect(speechResources).toEqual([{ from: packagePath, to: packagePath }])
    }

    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const stat = { isDirectory: () => false }
    for (const packageName of [
      'sherpa-onnx',
      'sherpa-onnx-darwin-arm64',
      'sherpa-onnx-darwin-x64',
      'sherpa-onnx-linux-arm64',
      'sherpa-onnx-linux-x64',
      'sherpa-onnx-win-x64'
    ]) {
      expect(isPacked(`/app/node_modules/${packageName}/index.js`, stat)).toBe(false)
    }
    expect(isPacked('/app/node_modules/ws/index.js', stat)).toBe(true)
  })
})
