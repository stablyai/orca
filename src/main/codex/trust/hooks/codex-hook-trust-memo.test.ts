import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getCodexHookTrustMemoPath,
  memoizeCodexHookAnswer,
  readEveryMemoizedCodexHookHashes,
  readMemoizedCodexHookAnswer,
  readMemoizedVersionAnswer
} from './codex-hook-trust-memo'
import { fingerprintCodex, type CodexHookHashes } from './codex-hook-trust-derivation'

let userData: string
let codexPath: string
const COMMAND = '/home/u/.orca/agent-hooks/codex-hook.sh'
const HASHES = { stop: 'sha256:stop', session_start: 'sha256:start' }

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-codex-trust-memo-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  codexPath = join(userData, 'codex')
  writeFileSync(codexPath, 'codex 0.150.1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(userData, { recursive: true, force: true })
})

function fingerprint(path = codexPath): string {
  return fingerprintCodex(path) ?? 'missing'
}

function remember(
  path = codexPath,
  codexVersion = 'codex-cli 0.150.1',
  hashes: CodexHookHashes = HASHES
): void {
  memoizeCodexHookAnswer(path, fingerprint(path), COMMAND, { kind: 'hashes', codexVersion, hashes })
}

const read = (command = COMMAND) => readMemoizedCodexHookAnswer(codexPath, command, fingerprint())

describe('Codex hook trust memo', () => {
  it('answers for the same binary bytes and hook command, and only those', () => {
    remember()

    expect(read()).toEqual({ kind: 'hashes', codexVersion: 'codex-cli 0.150.1', hashes: HASHES })
    expect(read('/other/codex-hook.sh')).toBeNull()

    writeFileSync(codexPath, 'codex 0.160.0, replaced by an update')
    expect(read()).toBeNull()
    // Version hashes survive binary replacement, avoiding hooks/list after reinstall.
    expect(readMemoizedVersionAnswer('codex-cli 0.150.1', COMMAND)).toMatchObject({
      hashes: HASHES
    })
  })

  it("keeps Codex's refusal for its version, for any binary of that version", () => {
    memoizeCodexHookAnswer(codexPath, fingerprint(), COMMAND, {
      kind: 'refused',
      codexVersion: 'codex-cli 0.127.0',
      failure: 'Codex 0.127.0 is too old for Orca status; update Codex'
    })

    expect(read()).toEqual({
      kind: 'refused',
      codexVersion: 'codex-cli 0.127.0',
      failure: 'Codex 0.127.0 is too old for Orca status; update Codex'
    })
    expect(readMemoizedVersionAnswer('codex-cli 0.127.0', COMMAND)?.kind).toBe('refused')
    expect(readEveryMemoizedCodexHookHashes()).toEqual([])
  })

  it('lists the hashes of every saved version, not only the current binary', () => {
    remember(codexPath, 'codex-cli 0.150.1', { stop: 'sha256:old-stop' })
    writeFileSync(codexPath, 'codex 0.160.0')
    remember(codexPath, 'codex-cli 0.160.0', { stop: 'sha256:new-stop' })

    expect(readEveryMemoizedCodexHookHashes().map((hashes) => hashes.stop)).toEqual([
      'sha256:old-stop',
      'sha256:new-stop'
    ])
  })

  it('ignores hashes saved for the unnamed hook but still recognizes them as Orca approvals', () => {
    writeFileSync(
      getCodexHookTrustMemoPath(),
      JSON.stringify({
        binaries: {},
        versions: { 'codex-cli 0.150.1': { command: COMMAND, hashes: { stop: 'sha256:unnamed' } } }
      })
    )

    expect(readMemoizedVersionAnswer('codex-cli 0.150.1', COMMAND)).toBeNull()
    expect(readEveryMemoizedCodexHookHashes()).toEqual([{ stop: 'sha256:unnamed' }])
  })

  it('drops hashes that are not strings, and events Orca does not hook', () => {
    writeFileSync(
      getCodexHookTrustMemoPath(),
      JSON.stringify({
        binaries: {},
        versions: {
          'codex-cli 0.150.1': {
            command: COMMAND,
            hashes: { stop: '', session_start: 42, bogus: 'x' }
          }
        }
      })
    )

    expect(readMemoizedVersionAnswer('codex-cli 0.150.1', COMMAND)).toBeNull()
  })
})
