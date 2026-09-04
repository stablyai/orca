import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  getCodexPaneAccount,
  recordCodexPaneAccount
} from './codex-pane-account-registry'

let userDataPath: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-codex-pane-launch-profile-'))
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

describe('codex pane account registry launch profile', () => {
  it('keeps launchProfileId across a re-read of the persisted file', () => {
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'custom-home',
      launchProfileId: 'codex-secondary-home'
    })
    // Why: a restart reads the file back through parseRegistry, which whitelists fields.
    _internals.resetCache()
    expect(getCodexPaneAccount('pty-1')).toEqual({
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'custom-home',
      launchProfileId: 'codex-secondary-home'
    })
  })

  it('drops a malformed launchProfileId instead of trusting the file', () => {
    recordCodexPaneAccount('pty-2', {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'custom-home',
      launchProfileId: 'Not A Slug'
    })
    _internals.resetCache()
    expect(getCodexPaneAccount('pty-2')).toEqual({
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'custom-home'
    })
  })
})
