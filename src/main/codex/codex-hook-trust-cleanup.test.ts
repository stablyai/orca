import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeTrustKey,
  escapeTomlString,
  readHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { removeStaleRuntimeHookTrustEntries } from './codex-hook-trust-cleanup'

let dir: string
let tomlPath: string
let hooksPath: string

function entry(command: string, groupIndex: number): CodexTrustEntry {
  return { sourcePath: hooksPath, eventLabel: 'stop', groupIndex, handlerIndex: 0, command }
}

beforeEach(() => {
  // Why realpath: runtime keys are resolved, and the temp dir may sit under a symlink.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-codex-trust-cleanup-')))
  tomlPath = join(dir, 'config.toml')
  hooksPath = join(dir, 'hooks.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('removeStaleRuntimeHookTrustEntries', () => {
  it('removes an unexpected key whose duplicate tables disagree, so read as no hash', () => {
    const expected = { ...entry('orca.sh', 0), trustedHash: 'sha256:orca' }
    const staleKey = escapeTomlString(computeTrustKey(entry('gone.sh', 1)))
    writeFileSync(
      tomlPath,
      `[hooks.state."${escapeTomlString(computeTrustKey(expected))}"]\ntrusted_hash = "sha256:orca"\n\n` +
        `[hooks.state."${staleKey}"]\ntrusted_hash = "sha256:a"\n\n` +
        `[hooks.state."${staleKey}"]\ntrusted_hash = "sha256:b"\n`
    )

    removeStaleRuntimeHookTrustEntries(tomlPath, hooksPath, [expected])

    expect(readFileSync(tomlPath, 'utf-8')).not.toContain(staleKey)
    expect(readHookTrustEntries(tomlPath).get(computeTrustKey(expected))?.trustedHash).toBe(
      'sha256:orca'
    )
  })
})
