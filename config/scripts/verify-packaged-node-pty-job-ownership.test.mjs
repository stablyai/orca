import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  verifyPackagedNodePtyJobOwnership
} = require('./verify-packaged-node-pty-job-ownership.cjs')

const PATCHED = {
  dir: '../build/Release/',
  module: {
    listJobProcessIds: () => [],
    terminateJob: () => true,
    assignCurrentProcessToJob: () => true
  }
}

describe('verifyPackagedNodePtyJobOwnership', () => {
  it('accepts the packaged patched ConPTY binding', () => {
    expect(() =>
      verifyPackagedNodePtyJobOwnership('resources', {
        platform: 'win32',
        loadNative: () => PATCHED
      })
    ).not.toThrow()
  })

  it('rejects a packaged upstream prebuild', () => {
    expect(() =>
      verifyPackagedNodePtyJobOwnership('resources', {
        platform: 'win32',
        loadNative: () => ({ dir: '../prebuilds/win32-x64/', module: {} })
      })
    ).toThrow(/missing listJobProcessIds, terminateJob, assignCurrentProcessToJob/)
  })

  it('requires the patched source-build directory', () => {
    expect(() =>
      verifyPackagedNodePtyJobOwnership('resources', {
        platform: 'win32',
        loadNative: () => ({ ...PATCHED, dir: '../prebuilds/win32-x64/' })
      })
    ).toThrow(/expected patched build\/Release/)
  })

  it('does not load Windows natives for other targets', () => {
    const loadNative = vi.fn()
    verifyPackagedNodePtyJobOwnership('resources', { platform: 'linux', loadNative })
    expect(loadNative).not.toHaveBeenCalled()
  })
})
