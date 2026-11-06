import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle, on: electronMocks.on }
}))

import { parsePluginConsentArgs, parsePluginInstallArgs } from './plugins'

beforeEach(() => {
  electronMocks.handle.mockReset()
  electronMocks.on.mockReset()
})

describe('plugin consent IPC schema', () => {
  it('requires the fingerprint reviewed by the caller', () => {
    expect(() =>
      parsePluginConsentArgs({ pluginKey: 'samples.demo', decision: 'approve' })
    ).toThrow()
  })
})

describe('plugin install IPC schema', () => {
  it('carries only a full commit as the commit the dialog showed', () => {
    const source = { kind: 'git', url: 'https://example.com/plugin.git', ref: 'v1.2.3' }
    expect(parsePluginInstallArgs({ ...source, expectedCommit: 'a'.repeat(40) })).toEqual({
      ...source,
      expectedCommit: 'a'.repeat(40)
    })
    expect(() => parsePluginInstallArgs({ ...source, expectedCommit: 'abc1234' })).toThrow()
  })

  it('rejects executable helpers and embedded HTTPS credentials', () => {
    expect(() =>
      parsePluginInstallArgs({ kind: 'git', url: 'ext::sh -c calc', ref: 'main' })
    ).toThrow()
    expect(() =>
      parsePluginInstallArgs({
        kind: 'git',
        url: 'https://user@example.com/plugin.git',
        ref: 'main'
      })
    ).toThrow()
  })
})
