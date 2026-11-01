import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  clearHookTrustKeySeparatorVariants,
  resolveMirroredRuntimeUserHookTrustEntries,
  stampMirroredRuntimeTrustWithCurrentHashes
} from './codex-mirrored-hook-runtime-trust'
import {
  getHookTrustKeyWriteVariants,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

const SYSTEM_HASH = 'sha256:system-source-hash'
const RUNTIME_HASH = 'sha256:runtime-current-hash'

function windowsUserHookEntry(trustedHash = SYSTEM_HASH): CodexTrustEntry {
  return {
    sourcePath: 'C:\\Users\\Rod\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\hooks.json',
    eventLabel: 'pre_tool_use',
    groupIndex: 1,
    handlerIndex: 0,
    command: 'user-pre-tool-hook',
    trustedHash
  }
}

describe('stampMirroredRuntimeTrustWithCurrentHashes', () => {
  it('replaces the system hash with the matching runtime currentHash', () => {
    const entry = windowsUserHookEntry()
    const slashKey =
      'C:/Users/Rod/AppData/Roaming/orca/codex-runtime-home/home/hooks.json:pre_tool_use:1:0'
    const stamped = stampMirroredRuntimeTrustWithCurrentHashes(
      [entry],
      [{ key: slashKey, command: 'user-pre-tool-hook', currentHash: RUNTIME_HASH }]
    )
    expect(stamped[0]?.trustedHash).toBe(RUNTIME_HASH)
    expect(stamped[0]?.trustedHash).not.toBe(SYSTEM_HASH)
  })

  it('keeps the system hash when the listing command does not match', () => {
    const entry = windowsUserHookEntry()
    const stamped = stampMirroredRuntimeTrustWithCurrentHashes(
      [entry],
      [
        {
          key: 'C:\\Users\\Rod\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\hooks.json:pre_tool_use:1:0',
          command: 'some-other-hook',
          currentHash: RUNTIME_HASH
        }
      ]
    )
    expect(stamped[0]?.trustedHash).toBe(SYSTEM_HASH)
  })

  it('keeps the system hash when hooks/list omits command', () => {
    const entry = windowsUserHookEntry()
    const stamped = stampMirroredRuntimeTrustWithCurrentHashes(
      [entry],
      [
        {
          key: 'C:\\Users\\Rod\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\hooks.json:pre_tool_use:1:0',
          command: null,
          currentHash: RUNTIME_HASH
        }
      ]
    )
    expect(stamped[0]?.trustedHash).toBe(SYSTEM_HASH)
  })
})

describe('clearHookTrustKeySeparatorVariants', () => {
  let tmpDir: string
  let tomlPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-mirrored-hook-trust-'))
    tomlPath = join(tmpDir, 'config.toml')
  })

  afterEach(() => {
    _internals.setListRunner(null)
    _internals.resetRetryState()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('clears both Windows separator variants then writes the runtime currentHash on both', () => {
    const entry = windowsUserHookEntry()
    const backslashKey =
      'C:\\Users\\Rod\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\hooks.json:pre_tool_use:1:0'
    const slashKey =
      'C:/Users/Rod/AppData/Roaming/orca/codex-runtime-home/home/hooks.json:pre_tool_use:1:0'
    writeFileSync(
      tomlPath,
      [
        `[hooks.state.'${backslashKey}']`,
        'enabled = true',
        `trusted_hash = "${SYSTEM_HASH}"`,
        '',
        `[hooks.state.'${slashKey}']`,
        'enabled = true',
        'trusted_hash = "sha256:other-separator-hash"',
        ''
      ].join('\n'),
      'utf-8'
    )

    expect(getHookTrustKeyWriteVariants(backslashKey)).toEqual(
      expect.arrayContaining([backslashKey, slashKey])
    )
    clearHookTrustKeySeparatorVariants(tomlPath, [backslashKey])
    upsertHookTrustEntries(tomlPath, [{ ...entry, trustedHash: RUNTIME_HASH }])

    const written = readFileSync(tomlPath, 'utf-8')
    expect(written).toContain(`[hooks.state.'${backslashKey}']`)
    expect(written).toContain(`[hooks.state.'${slashKey}']`)
    expect((written.match(/trusted_hash = "sha256:runtime-current-hash"/g) ?? []).length).toBe(2)
    expect(written).not.toContain(SYSTEM_HASH)
    expect(written).not.toContain('sha256:other-separator-hash')
    expect(readHookTrustEntries(tomlPath).get(slashKey)?.trustedHash).toBe(RUNTIME_HASH)
  })

  it('resolves mirrored entries with hooks/list currentHash instead of the system hash', async () => {
    mkdirSync(join(tmpDir, 'home'), { recursive: true })
    const runtimeHomePath = join(tmpDir, 'home')
    writeFileSync(tomlPath, 'model = "runtime"\n', 'utf-8')
    const posixEntry: CodexTrustEntry = {
      sourcePath: join(runtimeHomePath, 'hooks.json'),
      eventLabel: 'pre_tool_use',
      groupIndex: 1,
      handlerIndex: 0,
      command: 'user-pre-tool-hook',
      trustedHash: SYSTEM_HASH
    }
    _internals.setListRunner(() => [
      {
        key: `${posixEntry.sourcePath}:pre_tool_use:1:0`,
        command: 'user-pre-tool-hook',
        currentHash: RUNTIME_HASH
      }
    ])

    const resolved = await resolveMirroredRuntimeUserHookTrustEntries({
      entries: [posixEntry],
      runtimeHomePath,
      tomlPath
    })
    expect(resolved[0]?.trustedHash).toBe(RUNTIME_HASH)
    expect(resolved[0]?.trustedHash).not.toBe(SYSTEM_HASH)
  })
})
