import { describe, expect, it } from 'vitest'
import { isGrokManagedPathInsideRoot } from './managed-home'

describe('Grok managed home containment', () => {
  it('rejects Windows paths on a different drive', () => {
    expect(
      isGrokManagedPathInsideRoot(
        'D:\\other\\grok-accounts\\account-1\\home',
        'C:\\Users\\Ada\\AppData\\Roaming\\Orca\\grok-accounts',
        'win32'
      )
    ).toBe(false)
  })

  it('accepts Windows child paths case-insensitively', () => {
    expect(
      isGrokManagedPathInsideRoot(
        'c:\\users\\ada\\appdata\\roaming\\orca\\grok-accounts\\account-1\\home',
        'C:\\Users\\Ada\\AppData\\Roaming\\Orca\\grok-accounts',
        'win32'
      )
    ).toBe(true)
  })

  it('rejects sibling prefixes that only look like the managed root', () => {
    expect(
      isGrokManagedPathInsideRoot(
        '/Users/ada/Library/Application Support/Orca/grok-accounts-evil/account-1/home',
        '/Users/ada/Library/Application Support/Orca/grok-accounts',
        'darwin'
      )
    ).toBe(false)
  })
})
