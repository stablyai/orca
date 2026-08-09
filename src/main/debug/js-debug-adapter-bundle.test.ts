import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveDapDebugServerEntrypoint,
  resolveJsDebugAdapterRoot
} from './js-debug-adapter-bundle'

describe('resolveJsDebugAdapterRoot', () => {
  it('resolves under process.resourcesPath when packaged', () => {
    expect(
      resolveJsDebugAdapterRoot({
        isPackaged: true,
        resourcesPath: '/Applications/Orca.app/Contents/Resources',
        appPath: '/Applications/Orca.app/Contents/Resources/app.asar'
      })
    ).toBe(join('/Applications/Orca.app/Contents/Resources', 'debug-adapters', 'js-debug'))
  })

  it('resolves under resources/ inside the repo checkout when not packaged', () => {
    expect(
      resolveJsDebugAdapterRoot({
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: '/repo/checkout'
      })
    ).toBe(join('/repo/checkout', 'resources', 'debug-adapters', 'js-debug'))
  })
})

describe('resolveDapDebugServerEntrypoint', () => {
  it('points at src/dapDebugServer.js inside the bundle root', () => {
    expect(resolveDapDebugServerEntrypoint('/some/root')).toBe(
      join('/some/root', 'src', 'dapDebugServer.js')
    )
  })
})
