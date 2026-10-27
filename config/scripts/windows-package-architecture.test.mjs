import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { getAgentBrowserBinaryName } from '../../src/main/browser/agent-browser-binary-name'
import {
  findInstallerAssetName,
  WINDOWS_ARM64_UPDATE_CHANNEL
} from '../../src/shared/release-channel'

const require = createRequire(import.meta.url)
const {
  createWindowsArchitectureResources,
  getWindowsInstallerArtifactName,
  getWindowsUpdateChannelPublishOptions
} = require('../windows-package-architecture.cjs')

describe('Windows package architecture resources', () => {
  it('omits the x64-only speech addon from ARM64 packages', () => {
    const resources = createWindowsArchitectureResources({ ORCA_WINDOWS_ARM64_BUILD: '1' })
    expect(resources).toContainEqual({
      from: 'node_modules/agent-browser/bin/agent-browser-win32-x64.exe',
      to: 'agent-browser-win32-x64.exe'
    })
    expect(resources.some((resource) => resource.from.includes('sherpa-onnx'))).toBe(false)
    expect(getWindowsInstallerArtifactName({ ORCA_WINDOWS_ARM64_BUILD: '1' })).toBe(
      'orca-windows-setup-arm64.${ext}'
    )
  })

  it('keeps existing x64 resources and artifact naming by default', () => {
    const resources = createWindowsArchitectureResources({})
    expect(resources).toContainEqual({
      from: 'node_modules/sherpa-onnx-win-x64',
      to: 'node_modules/sherpa-onnx-win-x64'
    })
    expect(getWindowsInstallerArtifactName({})).toBe('orca-windows-setup.${ext}')
  })

  it('packages the same Windows ARM64 browser fallback that runtime resolves', () => {
    const resources = createWindowsArchitectureResources({ ORCA_WINDOWS_ARM64_BUILD: '1' })
    const browserResource = resources.find((resource) => resource.from.includes('agent-browser'))
    expect(browserResource?.to).toBe(getAgentBrowserBinaryName('win32', 'arm64'))
  })

  it('publishes the ARM64 manifest and installer that the updater looks for', () => {
    const env = { ORCA_WINDOWS_ARM64_BUILD: '1' }
    expect(getWindowsUpdateChannelPublishOptions(env)).toEqual({
      channel: WINDOWS_ARM64_UPDATE_CHANNEL
    })
    expect(getWindowsUpdateChannelPublishOptions({})).toEqual({})
    const installer = getWindowsInstallerArtifactName(env).replace('${ext}', 'exe')
    expect(findInstallerAssetName('win32', [installer], 'arm64')).toBe(installer)
    expect(findInstallerAssetName('win32', [installer], 'x64')).toBeNull()
  })
})
