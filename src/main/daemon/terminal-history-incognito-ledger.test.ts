import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { IncognitoSessionLedger } from './terminal-history-incognito-ledger'

const LEDGER_FILE = '.incognito-sessions.json'

describe('IncognitoSessionLedger', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'incognito-ledger-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('persists and reloads ids across a fresh instance (a daemon/app restart)', () => {
    const first = new IncognitoSessionLedger(dir)
    expect(first.mark('sess-a')).toBe(true)

    const reloaded = new IncognitoSessionLedger(dir)
    expect(reloaded.has('sess-a')).toBe(true)
  })

  it('an ABSENT ledger is a silent first run, not a failure', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ledger = new IncognitoSessionLedger(dir)

    expect(ledger.has('anything')).toBe(false)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('treats a valid-JSON-but-not-an-array ledger as untrusted (not a benign empty start)', () => {
    // A torn/wrong-shaped write can parse as JSON yet carry no id array (e.g. `{}`); the old
    // Array.isArray check skipped it silently. It must be treated as untrusted, same as a parse error.
    writeFileSync(join(dir, LEDGER_FILE), '{"not":"an array"}')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ledger = new IncognitoSessionLedger(dir)

    expect(ledger.isUntrusted()).toBe(true)
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('fails closed on a re-adopt while untrusted, but lets an explicitly non-incognito session record', () => {
    writeFileSync(join(dir, LEDGER_FILE), 'not json')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ledger = new IncognitoSessionLedger(dir)

    expect(ledger.isUntrusted()).toBe(true)
    // Re-adopt (no explicit flag) → suppress (could be a lost incognito id).
    expect(ledger.suppressesCapture('readopted-unknown')).toBe(true)
    // Explicitly incognito → suppress. Explicitly NON-incognito (a fresh new session) → record.
    expect(ledger.suppressesCapture('x', true)).toBe(true)
    expect(ledger.suppressesCapture('fresh-normal', false)).toBe(false)
  })

  it('does not suppress an unknown re-adopt when the ledger is trusted', () => {
    const ledger = new IncognitoSessionLedger(dir) // absent file → trusted + empty
    expect(ledger.isUntrusted()).toBe(false)
    expect(ledger.suppressesCapture('some-normal-session')).toBe(false)
    ledger.mark('priv')
    expect(ledger.suppressesCapture('priv')).toBe(true)
  })

  it('rejects an array with a non-string id as untrusted (partial corruption), not a partial list', () => {
    // Corruption that turns one id into null must not be silently dropped while the rest is trusted —
    // the lost id would then be re-adopted and recorded. The whole file is rejected.
    writeFileSync(join(dir, LEDGER_FILE), JSON.stringify(['sess-a', null, 'sess-b']))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const ledger = new IncognitoSessionLedger(dir)

    expect(ledger.isUntrusted()).toBe(true)
    expect(ledger.suppressesCapture('sess-a')).toBe(true) // untrusted → every re-adopt fails closed
  })

  it('keeps distrust DURABLE across restarts via the preserved sibling', () => {
    writeFileSync(join(dir, LEDGER_FILE), 'not json')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = new IncognitoSessionLedger(dir)
    expect(first.isUntrusted()).toBe(true)
    first.mark('sess-live') // renames the corrupt file aside, writes a fresh VALID (but lossy) ledger

    // A restart reads the now-valid ledger. It must STILL be untrusted because the preserved sibling
    // signals the lost ids were never recovered — otherwise formerly-private re-adopts would record.
    const afterRestart = new IncognitoSessionLedger(dir)
    expect(afterRestart.isUntrusted()).toBe(true)
    expect(afterRestart.suppressesCapture('some-readopt')).toBe(true)
    expect(afterRestart.has('sess-live')).toBe(true) // the valid ledger's own ids still load

    // Operator removes the preserved sibling once no private session is at risk → distrust clears.
    for (const name of readdirSync(dir).filter((n) => n.startsWith(`${LEDGER_FILE}.unreadable-`))) {
      rmSync(join(dir, name))
    }
    const recovered = new IncognitoSessionLedger(dir)
    expect(recovered.isUntrusted()).toBe(false)
    expect(recovered.suppressesCapture('some-readopt')).toBe(false)
  })

  it('still leaves a durable marker when the preservation rename fails (corrupt file vanished)', () => {
    // If the corrupt file cannot be moved aside — here it is deleted before persist(), so the rename
    // hits ENOENT — persist() must NOT overwrite with a lossy ledger that a later load would trust.
    // It writes an empty distrust marker instead, so distrust survives the restart.
    const ledgerPath = join(dir, LEDGER_FILE)
    writeFileSync(ledgerPath, 'corrupt')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ledger = new IncognitoSessionLedger(dir)
    expect(ledger.isUntrusted()).toBe(true)

    rmSync(ledgerPath) // the corrupt file vanishes before the preserve-rename runs
    expect(ledger.mark('sess-x')).toBe(true)

    const markers = readdirSync(dir).filter((n) => n.startsWith(`${LEDGER_FILE}.unreadable-`))
    expect(markers).toHaveLength(1)
    // The restart sees the marker and stays untrusted, even though the main ledger now parses.
    const afterRestart = new IncognitoSessionLedger(dir)
    expect(afterRestart.isUntrusted()).toBe(true)
  })

  it('fails LOUD and preserves the file when an existing ledger is unreadable', () => {
    // A ledger that EXISTS but cannot be parsed hides WHICH sessions must stay unrecorded. Starting
    // empty+silent would let a restart re-adopt them as normal terminals and record them — fail-open.
    writeFileSync(join(dir, LEDGER_FILE), '{ this is not json')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ledger = new IncognitoSessionLedger(dir)

    // Surfaced loudly rather than swallowed.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]?.[0]).toContain('unreadable')

    // A new incognito session can still be recorded durably...
    expect(ledger.mark('sess-new')).toBe(true)
    // ...and the unreadable original is preserved (renamed aside), not silently clobbered.
    const preserved = readdirSync(dir).filter((f) => f.startsWith(`${LEDGER_FILE}.unreadable-`))
    expect(preserved).toHaveLength(1)
    expect(readFileSync(join(dir, preserved[0]), 'utf8')).toBe('{ this is not json')

    // The rewritten ledger is now valid and holds the new id.
    const reloaded = new IncognitoSessionLedger(dir)
    expect(reloaded.has('sess-new')).toBe(true)
  })

  it('does not preserve-rename again on a second persist after recovery', () => {
    writeFileSync(join(dir, LEDGER_FILE), 'not json')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ledger = new IncognitoSessionLedger(dir)

    ledger.mark('sess-1')
    ledger.mark('sess-2')

    const preserved = readdirSync(dir).filter((f) => f.startsWith(`${LEDGER_FILE}.unreadable-`))
    expect(preserved).toHaveLength(1)
    expect(existsSync(join(dir, LEDGER_FILE))).toBe(true)
  })
})
