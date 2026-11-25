import { describe, expect, it } from 'vitest'
import {
  attributedCodexHome,
  transcriptIsUnderCodexHome
} from './codex-account-restart-launch-route'

const settings = { codexManagedAccounts: [{ id: 'acct-a', managedHomePath: '/data/acct-a/home' }] }

describe('the Codex home a launch really ran on', () => {
  it('names the system home for the default account and the managed home for an owned one', () => {
    expect(
      attributedCodexHome({ accountId: null, homeRoute: 'real-home' }, settings, '/u/.codex')
    ).toBe('/u/.codex')
    expect(
      attributedCodexHome({ accountId: 'acct-a', homeRoute: 'account-home' }, settings, '/u/.codex')
    ).toBe('/data/acct-a/home')
  })

  it('names no home for a removed account or a home no account owns', () => {
    expect(
      attributedCodexHome({ accountId: 'gone', homeRoute: 'account-home' }, settings, '/u/.codex')
    ).toBeNull()
    expect(
      attributedCodexHome({ accountId: 'acct-a', homeRoute: 'shared-home' }, settings, '/u/.codex')
    ).toBeNull()
  })

  it('accepts only a transcript in that home sessions folder', () => {
    expect(transcriptIsUnderCodexHome('/u/.codex/sessions/2026/11/01/r.jsonl', '/u/.codex')).toBe(
      true
    )
    expect(transcriptIsUnderCodexHome('/u/.codex/sessions/2026/11/01/r.jsonl', '/u/.codex/')).toBe(
      true
    )
    // Inherited custom CODEX_HOME: same file name, another home.
    expect(transcriptIsUnderCodexHome('/custom/sessions/2026/11/01/r.jsonl', '/u/.codex')).toBe(
      false
    )
    // A sibling whose name only starts with the home's.
    expect(transcriptIsUnderCodexHome('/u/.codex-other/sessions/r.jsonl', '/u/.codex')).toBe(false)
    expect(
      transcriptIsUnderCodexHome('C:\\Users\\u\\.codex\\sessions\\r.jsonl', 'C:\\Users\\u\\.codex')
    ).toBe(true)
  })
})
