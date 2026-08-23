import { describe, expect, it } from 'vitest'
import type { CodexPaneAccountRecord } from './codex-pane-account-registry'
import {
  describeCodexPaneLaunchHomeFailure,
  resolveCodexPaneLaunchHome
} from './codex-pane-launch-home'

const SYSTEM_HOME = '/Users/dev/.codex'
const SHARED_HOME = '/Users/dev/Library/Application Support/orca/codex-runtime-home/home'
const ACCOUNT_HOME = '/Users/dev/Library/Application Support/orca/codex-accounts/acct-1/home'

const SETTINGS = {
  codexManagedAccounts: [
    {
      id: 'acct-1',
      email: 'dev@example.com',
      managedHomePath: ACCOUNT_HOME,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
  ]
}

function resolve(record: CodexPaneAccountRecord | null) {
  return resolveCodexPaneLaunchHome({
    record,
    settings: SETTINGS,
    systemCodexHomePath: SYSTEM_HOME,
    sharedRuntimeCodexHomePath: SHARED_HOME
  })
}

describe('resolveCodexPaneLaunchHome', () => {
  it('names the account home a managed pane launched under', () => {
    expect(
      resolve({ selectionKey: 'host', accountId: 'acct-1', homeRoute: 'account-home' })
    ).toEqual({ kind: 'attributed', path: ACCOUNT_HOME })
  })

  it('routes real-home and shared-home panes to their own homes', () => {
    expect(resolve({ selectionKey: 'host', accountId: null, homeRoute: 'real-home' })).toEqual({
      kind: 'attributed',
      path: SYSTEM_HOME
    })
    expect(resolve({ selectionKey: 'host', accountId: null, homeRoute: 'shared-home' })).toEqual({
      kind: 'attributed',
      path: SHARED_HOME
    })
  })

  it('prefers a recorded pane-local override over the route it was classified as', () => {
    expect(
      resolve({
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'real-home',
        environmentHomeOverride: { codexHome: '/tmp/isolated/home' }
      })
    ).toEqual({ kind: 'attributed', path: '/tmp/isolated/home' })
    expect(
      resolve({
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'shared-home',
        shellStartupHomeOverride: { home: '/Users/dev', codexHome: '/tmp/shell/home' }
      })
    ).toEqual({ kind: 'attributed', path: '/tmp/shell/home' })
  })

  it('declines rather than guessing when the pane cannot be attributed', () => {
    expect(resolve(null)).toEqual({ kind: 'unrecorded' })
    // A WSL lane can never answer for the local pane adoption asks about.
    expect(resolve({ selectionKey: 'wsl:Ubuntu', accountId: null, homeRoute: 'wsl-home' })).toEqual(
      { kind: 'unrecorded' }
    )
    // Recorded before route provenance existed, so the launch home is unknown.
    expect(resolve({ selectionKey: 'host', accountId: null })).toEqual({ kind: 'unnameable-home' })
    expect(resolve({ selectionKey: 'host', accountId: null, homeRoute: 'custom-home' })).toEqual({
      kind: 'unnameable-home'
    })
    expect(
      resolve({ selectionKey: 'host', accountId: 'acct-gone', homeRoute: 'account-home' })
    ).toEqual({ kind: 'unknown-account', accountId: 'acct-gone' })
  })

  it('names the account in the failure the user is shown', () => {
    expect(
      describeCodexPaneLaunchHomeFailure({ kind: 'unknown-account', accountId: 'acct-gone' })
    ).toContain('acct-gone')
    expect(describeCodexPaneLaunchHomeFailure({ kind: 'unrecorded' })).toContain(
      'which Codex account'
    )
  })
})
