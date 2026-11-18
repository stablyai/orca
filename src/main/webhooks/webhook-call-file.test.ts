import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFile from '../../shared/secure-storage/secure-file'
import { sweepWebhookCallFiles, writeWebhookCallFile } from './webhook-call-file'
import type { WebhookEnvelope } from '../../shared/connector-webhook-routes'

const ownerOnly = vi.hoisted(() => ({ holds: true }))
vi.mock('../../shared/secure-storage/secure-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFile>()
  return {
    ...actual,
    writeSecureFile: (...args: Parameters<typeof actual.writeSecureFile>) =>
      ownerOnly.holds ? actual.writeSecureFile(...args) : false
  }
})

const CALL = 'call_0123456789abcdefABCD'
const OTHER = 'call_0123456789abcdefABCE'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const ENVELOPE: WebhookEnvelope = {
  receivedAt: NOW,
  contentType: 'application/json',
  headers: {},
  body: { kind: 'json', value: { number: 1 } },
  truncated: false
}

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'orca-webhook-call-file-'))
  ownerOnly.holds = true
})
afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

describe('a call file', () => {
  it('is written owner-only or not at all, so the prompt falls back to the call RPC', () => {
    expect(writeWebhookCallFile(folder, CALL, ENVELOPE)).toEqual({
      name: `webhook-calls/${CALL}.untrusted.json`,
      path: join(folder, 'webhook-calls', `${CALL}.untrusted.json`)
    })
    ownerOnly.holds = false
    expect(writeWebhookCallFile(folder, OTHER, ENVELOPE)).toBeNull()
  })

  it('is swept past retention, or sooner when no ledger row owns it, counting the files left', async () => {
    const dir = join(folder, 'webhook-calls')
    mkdirSync(dir)
    const at = (callId: string, ageMs: number) => {
      const path = join(dir, `${callId}.untrusted.json`)
      writeFileSync(path, '{}')
      utimesSync(path, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000)
      return path
    }
    const owned = at(CALL, DAY)
    const old = at('call_00000000000000000001', 8 * DAY)
    const stray = at('call_00000000000000000002', 2 * 60 * 60 * 1000)
    const fresh = at('call_00000000000000000003', 60_000)
    expect(await sweepWebhookCallFiles(folder, new Set([owned, old]), NOW, 7 * DAY)).toBe(2)
    expect([owned, old, stray, fresh].map((path) => existsSync(path))).toEqual([
      true,
      false,
      false,
      true
    ])
  })

  it('sweeps a bot with no calls yet without a word', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await sweepWebhookCallFiles(folder, new Set(), NOW, 7 * DAY)).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    expect(existsSync(join(folder, 'webhook-calls'))).toBe(false)
  })
})
