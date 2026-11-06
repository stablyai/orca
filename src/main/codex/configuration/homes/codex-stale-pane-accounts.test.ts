import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  hasRecordedLegacyWslCodexPane,
  reconcileCodexPaneAccountsWithLivePtys,
  recordCodexPaneAccount
} from './codex-pane-account-registry'

let userDataPath: string
let previousUserDataPath: string | undefined

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
})
