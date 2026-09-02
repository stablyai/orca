import { describe, expect, it, vi } from 'vitest'

// Why: persistence.ts touches electron at import time; a minimal stub keeps
// this normalizer test focused instead of booting the full Store fixture.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-persistence-right-sidebar-tab-test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

import { normalizeRightSidebarTab } from './persistence'

describe('normalizeRightSidebarTab', () => {
  it.each(['explorer', 'search', 'vault', 'workspaces', 'source-control', 'checks', 'ports'])(
    'preserves the built-in %s tab',
    (tab) => {
      expect(normalizeRightSidebarTab(tab)).toBe(tab)
    }
  )

  // Regression: pr-checks was missing from the allow-list, so the folder
  // PR Checks tab silently reset to Explorer on every app restart.
  it('preserves the folder-only pr-checks tab across restarts', () => {
    expect(normalizeRightSidebarTab('pr-checks')).toBe('pr-checks')
  })

  it('preserves well-formed plugin panel tabs', () => {
    expect(normalizeRightSidebarTab('plugin:orca-samples.my-plugin/dashboard')).toBe(
      'plugin:orca-samples.my-plugin/dashboard'
    )
  })

  it('normalizes malformed plugin tabs to the default tab', () => {
    expect(normalizeRightSidebarTab('plugin:orca-samples.my-plugin')).toBe('explorer')
    expect(normalizeRightSidebarTab('plugin:orca-samples.my-plugin/panel/extra')).toBe('explorer')
    expect(normalizeRightSidebarTab('plugin:My_Plugin/Panel!')).toBe('explorer')
  })

  it('normalizes unknown values to the default tab', () => {
    expect(normalizeRightSidebarTab('bogus')).toBe('explorer')
    expect(normalizeRightSidebarTab(undefined)).toBe('explorer')
    expect(normalizeRightSidebarTab(42)).toBe('explorer')
  })
})
