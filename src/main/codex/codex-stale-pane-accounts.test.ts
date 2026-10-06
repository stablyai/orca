import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  _internals,
  forgetCodexPaneAccount,
  getCodexPaneAccount,
  hasAnyRecordedLegacyWslCodexPane,
  hasRecordedLegacySharedCodexPane,
  hasRecordedLegacyWslCodexPane,
  hasRecordedManagedHostCodexPane,
  isCodexPaneHomeRouteProvenAwayFromSharedHome,
  reconcileCodexPaneAccountsWithLivePtys,
  recordCodexPaneAccount
} from './codex-pane-account-registry'
import { forgetStaleCodexPanes, listStaleCodexPanes } from './codex-stale-pane-accounts'

let userDataPath: string
let previousUserDataPath: string | undefined

function settingsWithSelection(
  host: string | null,
  wsl: Record<string, string | null> = {}
): GlobalSettings {
  return {
    activeCodexManagedAccountId: host,
    activeCodexManagedAccountIdsByRuntime: { host, wsl }
  } as GlobalSettings
}

beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-codex-pane-accounts-'))
  process.env.ORCA_USER_DATA_PATH = userDataPath
  _internals.resetCache()
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  _internals.resetCache()
})

describe('codex pane account registry', () => {
  it('persists explicit pins and excludes them from global-selection restart notices', () => {
    recordCodexPaneAccount('existing-a', {
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home'
    })
    recordCodexPaneAccount('pinned-b', {
      selectionKey: 'host',
      accountId: 'account-b',
      homeRoute: 'account-home',
      pinned: true
    })
    recordCodexPaneAccount('pinned-system', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'real-home',
      pinned: true
    })
    const existing = getCodexPaneAccount('existing-a')
    _internals.resetCache()
    expect(getCodexPaneAccount('pinned-b')).toEqual({
      selectionKey: 'host',
      accountId: 'account-b',
      homeRoute: 'account-home',
      pinned: true
    })
    expect(getCodexPaneAccount('existing-a')).toEqual(existing)
    const ptyIds = ['existing-a', 'pinned-b', 'pinned-system']
    expect(listStaleCodexPanes({ ptyIds, settings: settingsWithSelection('account-a') })).toEqual(
      []
    )
    expect(
      listStaleCodexPanes({ ptyIds, settings: settingsWithSelection('account-c') }).map(
        (pane) => pane.ptyId
      )
    ).toEqual(['existing-a'])
  })

  it.each([
    ['real-home', true],
    ['account-home', true],
    ['wsl-home', true],
    ['shared-home', false],
    [undefined, false]
  ] as const)('classifies whether %s proves a pane avoided the shared home', (route, expected) => {
    expect(isCodexPaneHomeRouteProvenAwayFromSharedHome(route)).toBe(expected)
  })

  it('survives a process restart so a daemon-backed shell stays attributable', () => {
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home'
    })

    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toEqual({
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home'
    })
  })

  it('keeps pre-route records readable without inventing provenance', () => {
    writeFileSync(
      join(userDataPath, 'codex-pane-accounts.json'),
      JSON.stringify({
        version: 1,
        panes: { 'pty-1': { selectionKey: 'host', accountId: null } }
      })
    )
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toEqual({ selectionKey: 'host', accountId: null })
    expect(hasRecordedLegacySharedCodexPane()).toBe(true)
  })

  it('reads a custom-home record from an older build as the shared home it was', () => {
    writeFileSync(
      join(userDataPath, 'codex-pane-accounts.json'),
      JSON.stringify({
        version: 2,
        panes: { 'pty-1': { selectionKey: 'host', accountId: null, homeRoute: 'custom-home' } }
      })
    )
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toEqual({
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home'
    })
  })

  it('runs legacy reconciliation only for host panes that may use the shared home', () => {
    recordCodexPaneAccount('pty-real', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'real-home'
    })
    recordCodexPaneAccount('pty-account', {
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home'
    })
    recordCodexPaneAccount('pty-wsl', {
      selectionKey: 'wsl:Ubuntu',
      accountId: null,
      homeRoute: 'wsl-home'
    })

    expect(hasRecordedLegacySharedCodexPane()).toBe(false)

    recordCodexPaneAccount('pty-shared', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home'
    })

    expect(hasRecordedLegacySharedCodexPane()).toBe(true)
  })

  it('identifies only legacy runtime-home panes on the requested WSL lane', () => {
    recordCodexPaneAccount('pty-legacy', {
      selectionKey: 'wsl:Ubuntu',
      accountId: 'account-old',
      homeRoute: 'wsl-home'
    })
    recordCodexPaneAccount('pty-direct', {
      selectionKey: 'wsl:Ubuntu',
      accountId: 'account-new',
      homeRoute: 'account-home'
    })
    recordCodexPaneAccount('pty-other-distro', {
      selectionKey: 'wsl:Debian',
      accountId: 'account-debian',
      homeRoute: 'wsl-home'
    })
    recordCodexPaneAccount('pty-default', {
      selectionKey: 'wsl:__default__',
      accountId: null,
      homeRoute: 'wsl-home'
    })

    expect(hasRecordedLegacyWslCodexPane('wsl:Ubuntu')).toBe(true)
    expect(hasRecordedLegacyWslCodexPane('wsl:ubuntu')).toBe(true)
    forgetCodexPaneAccount('pty-legacy')
    expect(hasRecordedLegacyWslCodexPane('wsl:Ubuntu')).toBe(true)
    forgetCodexPaneAccount('pty-default')
    expect(hasRecordedLegacyWslCodexPane('wsl:Ubuntu')).toBe(false)
    expect(hasRecordedLegacyWslCodexPane('wsl:Debian')).toBe(true)
  })

  it('requests daemon reconciliation for WSL-only legacy records', () => {
    recordCodexPaneAccount('pty-direct', {
      selectionKey: 'wsl:Ubuntu',
      accountId: 'account-new',
      homeRoute: 'account-home'
    })
    expect(hasAnyRecordedLegacyWslCodexPane()).toBe(false)

    recordCodexPaneAccount('pty-legacy', {
      selectionKey: 'wsl:Ubuntu',
      accountId: 'account-old',
      homeRoute: 'wsl-home'
    })
    expect(hasAnyRecordedLegacyWslCodexPane()).toBe(true)
  })

  it('requests startup inventory only for managed host panes', () => {
    recordCodexPaneAccount('pty-real', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'real-home'
    })
    recordCodexPaneAccount('pty-wsl', {
      selectionKey: 'wsl:Ubuntu',
      accountId: 'account-wsl',
      homeRoute: 'account-home'
    })

    expect(hasRecordedManagedHostCodexPane()).toBe(false)

    recordCodexPaneAccount('pty-shared', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home'
    })

    expect(hasRecordedManagedHostCodexPane()).toBe(true)

    forgetCodexPaneAccount('pty-shared')
    expect(hasRecordedManagedHostCodexPane()).toBe(false)

    recordCodexPaneAccount('pty-account', {
      selectionKey: 'host',
      accountId: 'account-host',
      homeRoute: 'account-home'
    })

    expect(hasRecordedManagedHostCodexPane()).toBe(true)
  })

  it('drops leaked records that are absent from the authoritative daemon inventory', () => {
    recordCodexPaneAccount('pty-live', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home'
    })
    recordCodexPaneAccount('pty-dead', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home'
    })

    reconcileCodexPaneAccountsWithLivePtys(['pty-live'])
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-live')).not.toBeNull()
    expect(getCodexPaneAccount('pty-dead')).toBeNull()
    expect(hasRecordedLegacySharedCodexPane()).toBe(true)

    reconcileCodexPaneAccountsWithLivePtys([])
    expect(hasRecordedLegacySharedCodexPane()).toBe(false)
  })

  it('forgets a PTY so a reused id cannot inherit a dead pane account', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })

    forgetCodexPaneAccount('pty-1')
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toBeNull()
  })

  it('keeps every record below the tracking cap', () => {
    for (let index = 0; index < 20; index += 1) {
      recordCodexPaneAccount(`pty-${index}`, { selectionKey: 'host', accountId: 'account-a' })
    }
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-0')).not.toBeNull()
    expect(getCodexPaneAccount('pty-19')).not.toBeNull()
  })

  it('reads back nothing when the registry file is missing', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })
    rmSync(join(userDataPath, 'codex-pane-accounts.json'))
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toBeNull()
  })

  it.each([
    ['unparseable JSON', '{ not json'],
    ['a non-object document', '"panes"'],
    ['an array document', '[]'],
    ['a missing panes map', '{"version":1}'],
    ['a non-object panes map', '{"version":1,"panes":[]}']
  ])('reads back nothing and still records when the file holds %s', (_label, contents) => {
    writeFileSync(join(userDataPath, 'codex-pane-accounts.json'), contents)
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toBeNull()
    // Why: a corrupt file must not wedge the registry — the next spawn has to
    // still be attributable, or fix-3 prompts silently die on one bad write.
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })
    _internals.resetCache()
    expect(getCodexPaneAccount('pty-1')).toEqual({ selectionKey: 'host', accountId: 'account-a' })
  })

  it.each([
    ['unparseable JSON', '{ not json'],
    ['a malformed pane record', '{"version":2,"panes":{"pty-1":{"selectionKey":7}}}'],
    [
      'an invalid lane key',
      '{"version":2,"panes":{"pty-1":{"selectionKey":"Ubuntu","accountId":null}}}'
    ],
    ['an unknown registry version', '{"version":999,"panes":{}}']
  ])('refuses to authorize a destructive WSL drain from %s', (_label, contents) => {
    writeFileSync(join(userDataPath, 'codex-pane-accounts.json'), contents)
    _internals.resetCache()

    expect(() => hasRecordedLegacyWslCodexPane('wsl:Ubuntu')).toThrow('registry could not be read')
  })

  it('does not authorize retirement after a new pane repairs a corrupt registry', () => {
    writeFileSync(join(userDataPath, 'codex-pane-accounts.json'), '{ not json')
    _internals.resetCache()
    expect(() => hasRecordedLegacyWslCodexPane('wsl:Ubuntu')).toThrow()

    recordCodexPaneAccount('pty-direct', {
      selectionKey: 'wsl:Ubuntu',
      accountId: 'account-new',
      homeRoute: 'account-home'
    })
    _internals.resetCache()

    expect(hasRecordedLegacyWslCodexPane('wsl:Ubuntu')).toBe(true)

    reconcileCodexPaneAccountsWithLivePtys(['pty-direct', 'pty-legacy-unknown'])
    _internals.resetCache()
    expect(hasRecordedLegacyWslCodexPane('wsl:Ubuntu')).toBe(true)

    reconcileCodexPaneAccountsWithLivePtys(['pty-direct'])
    _internals.resetCache()
    expect(hasRecordedLegacyWslCodexPane('wsl:Ubuntu')).toBe(false)
  })

  it('drops a malformed record without discarding its valid siblings', () => {
    writeFileSync(
      join(userDataPath, 'codex-pane-accounts.json'),
      JSON.stringify({
        version: 1,
        panes: {
          'pty-bad': { selectionKey: 7, accountId: 'account-a' },
          'pty-good': { selectionKey: 'host', accountId: 'account-a' }
        }
      })
    )
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-bad')).toBeNull()
    expect(getCodexPaneAccount('pty-good')).toEqual({
      selectionKey: 'host',
      accountId: 'account-a'
    })
  })
})

describe('listStaleCodexPanes', () => {
  it('reports a pane launched under a now-deselected account', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })

    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1'],
        settings: settingsWithSelection('account-b')
      })
    ).toEqual([
      {
        ptyId: 'pty-1',
        launchAccountId: 'account-a',
        activeAccountId: 'account-b'
      }
    ])
  })

  it('reports a managed pane after the selection drops to the system default', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })

    expect(
      listStaleCodexPanes({ ptyIds: ['pty-1'], settings: settingsWithSelection(null) })
    ).toEqual([
      {
        ptyId: 'pty-1',
        launchAccountId: 'account-a',
        activeAccountId: null
      }
    ])
  })

  it('leaves a pane alone when its launch account is still selected', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })

    expect(
      listStaleCodexPanes({ ptyIds: ['pty-1'], settings: settingsWithSelection('account-a') })
    ).toEqual([])
  })

  it('leaves a pane on an older Codex home alone while its account is unchanged', () => {
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home'
    })

    expect(
      listStaleCodexPanes({ ptyIds: ['pty-1'], settings: settingsWithSelection(null) })
    ).toEqual([])
  })

  it('never reports an unrecorded PTY, so an upgrade cannot invent a prompt', () => {
    expect(
      listStaleCodexPanes({ ptyIds: ['pty-unknown'], settings: settingsWithSelection('account-b') })
    ).toEqual([])
  })

  it('stops reporting a pane the user chose to keep on the old account', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })
    recordCodexPaneAccount('pty-2', { selectionKey: 'host', accountId: 'account-a' })

    forgetStaleCodexPanes(['pty-1'])
    _internals.resetCache()

    // Why: the dismissal must outlive the app, or the startup sweep re-raises it.
    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1', 'pty-2'],
        settings: settingsWithSelection('account-b')
      })
    ).toEqual([
      {
        ptyId: 'pty-2',
        launchAccountId: 'account-a',
        activeAccountId: 'account-b'
      }
    ])
  })

  it('compares a WSL pane against its own distro selection', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'wsl:Ubuntu', accountId: 'account-a' })
    recordCodexPaneAccount('pty-2', { selectionKey: 'wsl:Debian', accountId: 'account-c' })

    expect(
      listStaleCodexPanes({
        ptyIds: ['pty-1', 'pty-2'],
        // Why: switching the host account must not restart WSL panes, and one
        // distro's switch must not restart another distro's panes.
        settings: settingsWithSelection('account-b', { Ubuntu: 'account-a', Debian: 'account-d' })
      })
    ).toEqual([
      {
        ptyId: 'pty-2',
        launchAccountId: 'account-c',
        activeAccountId: 'account-d'
      }
    ])
  })
})
