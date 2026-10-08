import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    // Why: the version's hashes outlive the binary, so a reinstall of that version asks no hooks/list.
    expect(readMemoizedVersionAnswer('codex-cli 0.150.1', COMMAND)).toMatchObject({
      hashes: HASHES
    })
  })

  it('keeps an answer that Codex needs no approval for its listed events', () => {
    remember(codexPath, 'codex-cli 0.128.0', { stop: null, session_start: null })

    expect(readMemoizedVersionAnswer('codex-cli 0.128.0', COMMAND)).toMatchObject({
      hashes: { stop: null, session_start: null }
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

  it('reads an unreadable or foreign file as empty, and keeps a bounded record', () => {
    writeFileSync(getCodexHookTrustMemoPath(), '{ not json')
    expect(read()).toBeNull()

    for (let index = 0; index < 12; index += 1) {
      const path = join(userData, `codex-${index}`)
      writeFileSync(path, `codex ${index}`)
      remember(path, `codex-cli 0.${index}.0`)
    }

    const memo = JSON.parse(readFileSync(getCodexHookTrustMemoPath(), 'utf-8'))
    expect(Object.keys(memo.binaries)).toHaveLength(8)
    expect(Object.keys(memo.versions)).toHaveLength(8)
    expect(readMemoizedVersionAnswer('codex-cli 0.11.0', COMMAND)).not.toBeNull()
    expect(readMemoizedVersionAnswer('codex-cli 0.0.0', COMMAND)).toBeNull()
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

  it('keeps a hash in any form Codex lists, as the derivation takes it', () => {
    remember(codexPath, 'codex-cli 0.150.1', { stop: 'blake3:stop' })

    expect(read()).toEqual({
      kind: 'hashes',
      codexVersion: 'codex-cli 0.150.1',
      hashes: { stop: 'blake3:stop' }
    })
  })

  it('leaves the file alone when the answer is already saved', () => {
    remember()
    const memoPath = getCodexHookTrustMemoPath()
    writeFileSync(memoPath, readFileSync(memoPath, 'utf-8').replace('\n', '\n '))
    const saved = readFileSync(memoPath, 'utf-8')

    remember()

    expect(readFileSync(memoPath, 'utf-8')).toBe(saved)
  })
})
