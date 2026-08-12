import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CODEX_CREDENTIAL_ABSENCE_GRACE_MS,
  CodexCredentialAbsenceGrace
} from './codex-credential-absence-grace'

const VALID_AUTH = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { access_token: 'a', id_token: 'b', refresh_token: 'c' }
})

describe('CodexCredentialAbsenceGrace', () => {
  let dir = ''
  let authPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-absence-grace-'))
    authPath = join(dir, 'auth.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats a torn mid-write read as transient until it outlives the grace window', () => {
    const grace = new CodexCredentialAbsenceGrace()
    writeFileSync(authPath, '{"tokens":{"acc', 'utf-8')

    expect(grace.assess(authPath, 1_000)).toEqual({ state: 'unreadable', durable: false })
    expect(grace.assess(authPath, 1_000 + CODEX_CREDENTIAL_ABSENCE_GRACE_MS - 1)).toEqual({
      state: 'unreadable',
      durable: false
    })
    expect(grace.assess(authPath, 1_000 + CODEX_CREDENTIAL_ABSENCE_GRACE_MS)).toEqual({
      state: 'unreadable',
      durable: true
    })
  })

  it('clears the absence clock when a transient failure heals', () => {
    const grace = new CodexCredentialAbsenceGrace()
    writeFileSync(authPath, '{"tokens":{"acc', 'utf-8')
    expect(grace.assess(authPath, 1_000).durable).toBe(false)

    writeFileSync(authPath, VALID_AUTH, 'utf-8')
    expect(grace.assess(authPath, 2_000)).toEqual({ state: 'present', durable: true })

    // A later absence starts a fresh grace window instead of inheriting the old clock.
    rmSync(authPath)
    expect(grace.assess(authPath, 100_000)).toEqual({ state: 'missing', durable: false })
    expect(grace.assess(authPath, 100_000 + CODEX_CREDENTIAL_ABSENCE_GRACE_MS)).toEqual({
      state: 'missing',
      durable: true
    })
  })

  it('keeps a permission-denied read inside the grace window before it turns durable', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }
    const grace = new CodexCredentialAbsenceGrace()
    writeFileSync(authPath, VALID_AUTH, 'utf-8')
    chmodSync(authPath, 0o000)

    expect(grace.assess(authPath, 1_000)).toEqual({ state: 'unreadable', durable: false })
    expect(grace.assess(authPath, 1_000 + CODEX_CREDENTIAL_ABSENCE_GRACE_MS)).toEqual({
      state: 'unreadable',
      durable: true
    })
  })

  it('reports settled credential-free JSON as durable immediately', () => {
    const grace = new CodexCredentialAbsenceGrace()
    writeFileSync(authPath, '{}', 'utf-8')
    expect(grace.assess(authPath, 1_000)).toEqual({ state: 'no-credential', durable: true })
  })
})
