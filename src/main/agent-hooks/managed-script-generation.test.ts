import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

import { writeManagedScript } from './installer-utils'
import { refreshManagedScriptIfPresent } from './managed-hook-script-refresh'
import {
  MANAGED_SCRIPT_GENERATION,
  MANAGED_SCRIPT_LEDGER_FILE,
  recordManagedScriptSync
} from './managed-script-generation'

const NEWER = MANAGED_SCRIPT_GENERATION + 1
const OLDER = MANAGED_SCRIPT_GENERATION - 1

let dir = ''
let script = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-script-generation-'))
  script = join(dir, 'claude-hook.sh')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** What another build's writer does: replace the bytes, then record its generation. */
function otherBuildWrites(content: string, generation: number | null): void {
  writeFileSync(script, content)
  if (generation !== null) {
    recordManagedScriptSync(script, content, generation)
  }
}

function ledgerEntry(): unknown {
  const ledger: unknown = JSON.parse(readFileSync(join(dir, MANAGED_SCRIPT_LEDGER_FILE), 'utf8'))
  return Reflect.get(Object(ledger), 'claude-hook.sh')
}

describe('managed script generations', () => {
  it('leaves a newer build’s script in place, on install and on refresh', async () => {
    otherBuildWrites('newer\n', NEWER)

    writeManagedScript(script, 'ours\n')
    expect(readFileSync(script, 'utf8')).toBe('newer\n')
    expect(await refreshManagedScriptIfPresent(script, 'ours\n')).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe('newer\n')
  })

  it('replaces an older build’s script and records this generation', async () => {
    otherBuildWrites('older\n', OLDER)

    expect(await refreshManagedScriptIfPresent(script, 'ours\n')).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe('ours\n')
    expect(ledgerEntry()).toMatchObject({ generation: MANAGED_SCRIPT_GENERATION })
  })

  it('ends on the newer script whichever build refreshes last', async () => {
    // This build first, then a newer one.
    writeManagedScript(script, 'ours\n')
    otherBuildWrites('newer\n', NEWER)
    expect(await refreshManagedScriptIfPresent(script, 'ours\n')).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe('newer\n')

    // An older build first, then this one.
    rmSync(join(dir, MANAGED_SCRIPT_LEDGER_FILE))
    otherBuildWrites('older\n', OLDER)
    writeManagedScript(script, 'ours\n')
    expect(readFileSync(script, 'utf8')).toBe('ours\n')
  })

  it('treats bytes from a build without the ledger as generation 0', async () => {
    otherBuildWrites('newer\n', NEWER)
    // A pre-ledger build rewrites the file and leaves the ledger stale.
    otherBuildWrites('pre-ledger\n', null)

    expect(await refreshManagedScriptIfPresent(script, 'ours\n')).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe('ours\n')
  })

  it('keeps the newer attribution when both builds write identical bytes', () => {
    otherBuildWrites('same\n', NEWER)

    writeManagedScript(script, 'same\n')
    expect(ledgerEntry()).toEqual({
      generation: NEWER,
      sha256: createHash('sha256').update('same\n').digest('hex')
    })
  })

  it('never lets the ledger block or fail a write', async () => {
    writeFileSync(join(dir, MANAGED_SCRIPT_LEDGER_FILE), '{"claude-hook.sh":')
    otherBuildWrites('torn\n', null)
    expect(await refreshManagedScriptIfPresent(script, 'ours\n')).toBe(true)
    expect(readFileSync(script, 'utf8')).toBe('ours\n')

    // An unwritable ledger costs only the record.
    rmSync(join(dir, MANAGED_SCRIPT_LEDGER_FILE))
    mkdirSync(join(dir, MANAGED_SCRIPT_LEDGER_FILE))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeManagedScript(script, 'again\n')
    expect(readFileSync(script, 'utf8')).toBe('again\n')
  })
})
