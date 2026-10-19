import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCodexHookApprovalsBeforeEntries } from './codex-hook-approval-first-write'
import {
  computeTrustKey,
  escapeTomlString,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

let home: string
const tomlPath = (): string => join(home, 'config.toml')
const hooksPath = (): string => join(home, 'hooks.json')
const COMMAND = '/u/.orca/agent-hooks/codex-hook.sh'

function approval(eventLabel: 'stop' | 'session_start', trustedHash: string): CodexTrustEntry {
  return {
    sourcePath: hooksPath(),
    eventLabel,
    groupIndex: 0,
    handlerIndex: 0,
    command: COMMAND,
    trustedHash,
    enabled: true
  }
}

function writeHooks(): void {
  writeFileSync(
    hooksPath(),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: COMMAND }] }] } })
  )
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-approval-first-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('writeCodexHookApprovalsBeforeEntries', () => {
  it('writes the approval before the entry', () => {
    let approvedAtWrite: string | undefined
    writeCodexHookApprovalsBeforeEntries(
      tomlPath(),
      [approval('stop', 'sha256:codex-stop')],
      () => {
        approvedAtWrite = readHookTrustEntries(tomlPath()).get(
          computeTrustKey(approval('stop', ''))
        )?.trustedHash
        writeHooks()
      },
      hooksPath()
    )

    expect(approvedAtWrite).toBe('sha256:codex-stop')
  })

  it('writes nothing to config.toml when the approval is already there', () => {
    upsertHookTrustEntries(tomlPath(), [approval('stop', 'sha256:codex-stop')])
    const before = readFileSync(tomlPath(), 'utf-8')

    writeCodexHookApprovalsBeforeEntries(
      tomlPath(),
      [approval('stop', 'sha256:codex-stop')],
      writeHooks,
      hooksPath()
    )

    expect(readFileSync(tomlPath(), 'utf-8')).toBe(before)
  })

  it("takes its approval back when the entry write fails, restoring a switched-off key verbatim, never another writer's", () => {
    // Why escaped: a Windows key's backslashes are escapes in a TOML basic string.
    const disabledOnly = `[hooks.state."${escapeTomlString(computeTrustKey(approval('stop', '')))}"]\nenabled = false\n`
    writeFileSync(tomlPath(), disabledOnly)

    expect(() =>
      writeCodexHookApprovalsBeforeEntries(
        tomlPath(),
        [approval('stop', 'sha256:codex-stop'), approval('session_start', 'sha256:codex-start')],
        () => {
          // Why: another writer approves the same key while Orca's entry write is failing.
          upsertHookTrustEntries(tomlPath(), [approval('session_start', 'sha256:other-writer')])
          throw new Error('disk full')
        },
        hooksPath()
      )
    ).toThrow('disk full')

    const trust = readHookTrustEntries(tomlPath())
    expect(trust.get(computeTrustKey(approval('stop', '')))).toEqual({
      trustedHash: undefined,
      enabled: false
    })
    expect(readFileSync(tomlPath(), 'utf-8')).toContain(disabledOnly.trim())
    expect(trust.get(computeTrustKey(approval('session_start', '')))?.trustedHash).toBe(
      'sha256:other-writer'
    )
  })

  it('keeps an approval whose entry did land before the failure', () => {
    expect(() =>
      writeCodexHookApprovalsBeforeEntries(
        tomlPath(),
        [approval('stop', 'sha256:codex-stop')],
        () => {
          writeHooks()
          throw new Error('later step failed')
        },
        hooksPath()
      )
    ).toThrow('later step failed')

    expect(
      readHookTrustEntries(tomlPath()).get(computeTrustKey(approval('stop', '')))?.trustedHash
    ).toBe('sha256:codex-stop')
  })
})
