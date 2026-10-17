import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  getCodexPaneAccount,
  recordCodexPaneAccount,
  setCodexPaneKept
} from './codex-pane-account-registry'

let userDataPath: string
let previousUserDataPath: string | undefined

function registryPath(): string {
  return join(userDataPath, 'codex-pane-accounts.json')
}

beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-codex-pane-kept-'))
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

describe('kept Codex pane records', () => {
  it('keeps a pane across a process restart and releases it again', () => {
    recordCodexPaneAccount('pty-1', {
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home'
    })

    expect(setCodexPaneKept('pty-1', true)).toBe('kept')
    _internals.resetCache()
    expect(getCodexPaneAccount('pty-1')).toEqual({
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home',
      kept: true
    })

    expect(setCodexPaneKept('pty-1', false)).toBe('released')
    _internals.resetCache()
    expect(getCodexPaneAccount('pty-1')).toEqual({
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home'
    })
  })

  it.each([['yes'], [1], [false], [null]])('reads kept=%j as a pane that follows', (kept) => {
    writeFileSync(
      registryPath(),
      JSON.stringify({
        version: 2,
        panes: { 'pty-1': { selectionKey: 'host', accountId: 'account-a', kept } }
      })
    )
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-1')).toEqual({ selectionKey: 'host', accountId: 'account-a' })
  })

  it('reports a pane with no launch record instead of inventing one', () => {
    expect(setCodexPaneKept('pty-unknown', true)).toBe('no-record')
    expect(getCodexPaneAccount('pty-unknown')).toBeNull()
  })

  it('refuses to keep against a registry it could not read and queues nothing', () => {
    recordCodexPaneAccount('pty-1', { selectionKey: 'host', accountId: 'account-a' })
    const persisted = readFileSync(registryPath(), 'utf-8')
    rmSync(registryPath())
    // Why: a directory in the file's place fails the read with EISDIR, not absence.
    mkdirSync(registryPath())
    _internals.resetCache()

    expect(setCodexPaneKept('pty-1', true)).toBe('unavailable')
    expect(statSync(registryPath()).isDirectory()).toBe(true)

    rmSync(registryPath(), { recursive: true })
    writeFileSync(registryPath(), persisted)
    expect(getCodexPaneAccount('pty-1')).toEqual({ selectionKey: 'host', accountId: 'account-a' })
  })

  it('never trims a kept record, even when it is the oldest one', () => {
    recordCodexPaneAccount('pty-kept', { selectionKey: 'host', accountId: 'account-a' })
    expect(setCodexPaneKept('pty-kept', true)).toBe('kept')
    recordCodexPaneAccount('pty-old', { selectionKey: 'host', accountId: 'account-a' })
    for (let index = 0; index < 2000; index += 1) {
      recordCodexPaneAccount(`pty-${index}`, { selectionKey: 'host', accountId: 'account-b' })
    }
    _internals.resetCache()

    expect(getCodexPaneAccount('pty-kept')).toEqual({
      selectionKey: 'host',
      accountId: 'account-a',
      kept: true
    })
    // Why: the oldest record nobody kept is the one that ages out.
    expect(getCodexPaneAccount('pty-old')).toBeNull()
    expect(getCodexPaneAccount('pty-0')).not.toBeNull()
    expect(getCodexPaneAccount('pty-1999')).not.toBeNull()
  })
})
