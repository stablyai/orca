import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookCommandConfig, HookDefinition } from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  getMovedCodexUserHookTrust,
  mutateRealHomeHooksPreservingUserTrust
} from './codex-user-hook-trust-moves'

let root: string
let hooksPath: string
let configPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-user-hook-trust-moves-'))
  hooksPath = join(root, 'hooks.json')
  configPath = join(root, 'config.toml')
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function command(command: string): HookCommandConfig {
  return { type: 'command', command }
}

function stopEntry(groupIndex: number, hook: HookCommandConfig): CodexTrustEntry {
  return {
    sourcePath: hooksPath,
    eventLabel: 'stop',
    groupIndex,
    handlerIndex: 0,
    command: hook.command!
  }
}

function mutate(
  before: Record<string, HookDefinition[]>,
  after: Record<string, HookDefinition[]>
): void {
  mutateRealHomeHooksPreservingUserTrust({
    sourcePaths: [hooksPath],
    tomlPath: configPath,
    beforeHooks: before,
    afterHooks: after,
    writeHooks: () => writeFileSync(hooksPath, JSON.stringify({ hooks: after }))
  })
}

describe('real-home user hook trust rebasing', () => {
  it('writes without touching config.toml when no hook moves', () => {
    const user = command('user-hook')
    mutate(
      { Stop: [{ hooks: [user] }] },
      { Stop: [{ hooks: [user] }, { hooks: [command('orca')] }] }
    )

    expect(existsSync(hooksPath)).toBe(true)
    expect(existsSync(configPath)).toBe(false)
  })

  it('finds multiple shifted user hooks, including a handler from a mixed group', async () => {
    const orca = command('orca-hook')
    const first = command('first-user')
    const second = command('second-user')
    const mixed = command('mixed-user')
    const before: Record<string, HookDefinition[]> = {
      Stop: [{ hooks: [orca] }, { hooks: [first] }, { hooks: [second] }, { hooks: [orca, mixed] }]
    }
    const after: Record<string, HookDefinition[]> = {
      Stop: [{ hooks: [first] }, { hooks: [second] }, { hooks: [mixed] }]
    }

    expect(getMovedCodexUserHookTrust(hooksPath, before, after)).toEqual([
      expect.objectContaining({
        command: 'first-user',
        oldKey: expect.stringContaining(':1:0'),
        newKey: expect.stringContaining(':0:0')
      }),
      expect.objectContaining({
        command: 'second-user',
        oldKey: expect.stringContaining(':2:0'),
        newKey: expect.stringContaining(':1:0')
      }),
      expect.objectContaining({
        command: 'mixed-user',
        oldKey: expect.stringContaining(':3:1'),
        newKey: expect.stringContaining(':2:0')
      })
    ])
  })

  it("moves each shifted hook's trust block to its new key, bytes unchanged", () => {
    const orca = command('orca-hook')
    const trusted = command('trusted-user')
    const disabled = command('disabled-user')
    const untrusted = command('untrusted-user')
    upsertHookTrustEntries(configPath, [
      { ...stopEntry(0, orca), trustedHash: 'sha256:orca' },
      { ...stopEntry(1, trusted), trustedHash: 'sha256:from-an-older-codex' },
      { ...stopEntry(2, disabled), trustedHash: 'sha256:disabled', enabled: false }
    ])
    writeFileSync(configPath, `model = "user-model"\n${readFileSync(configPath, 'utf-8')}`)

    mutate(
      {
        Stop: [
          { hooks: [orca] },
          { hooks: [trusted] },
          { hooks: [disabled] },
          { hooks: [untrusted] }
        ]
      },
      { Stop: [{ hooks: [trusted] }, { hooks: [disabled] }, { hooks: [untrusted] }] }
    )

    const trust = readHookTrustEntries(configPath)
    expect(trust.get(computeTrustKey(stopEntry(0, trusted)))).toEqual({
      trustedHash: 'sha256:from-an-older-codex',
      enabled: true
    })
    expect(trust.get(computeTrustKey(stopEntry(1, disabled)))).toEqual({
      trustedHash: 'sha256:disabled',
      enabled: false
    })
    // Why: an untrusted hook keeps no record, and the key it vacated holds none.
    expect(trust.get(computeTrustKey(stopEntry(2, untrusted)))).toBeUndefined()
    expect(trust.get(computeTrustKey(stopEntry(3, untrusted)))).toBeUndefined()
    expect(readFileSync(configPath, 'utf-8').startsWith('model = "user-model"\n')).toBe(true)
  })

  it('keeps the hooks write and reports when config.toml cannot be written', () => {
    const orca = command('orca-hook')
    const user = command('user-hook')
    upsertHookTrustEntries(configPath, [{ ...stopEntry(1, user), trustedHash: 'sha256:user' }])
    rmSync(configPath)
    mkdirSync(configPath)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mutate({ Stop: [{ hooks: [orca] }, { hooks: [user] }] }, { Stop: [{ hooks: [user] }] })

    expect(JSON.parse(readFileSync(hooksPath, 'utf-8')).hooks.Stop).toEqual([{ hooks: [user] }])
    expect(warn).toHaveBeenCalled()
  })

  it('moves nothing when any stored key has an unknown shape, leaving review to Codex', () => {
    const orca = command('orca-hook')
    const user = command('user-hook')
    upsertHookTrustEntries(configPath, [{ ...stopEntry(1, user), trustedHash: 'sha256:user' }])
    const before = `${readFileSync(configPath, 'utf-8')}\n[hooks.state."a-key-in-a-new-format"]\ntrusted_hash = "sha256:other"\n`
    writeFileSync(configPath, before)

    mutate({ Stop: [{ hooks: [orca] }, { hooks: [user] }] }, { Stop: [{ hooks: [user] }] })

    expect(JSON.parse(readFileSync(hooksPath, 'utf-8')).hooks.Stop).toEqual([{ hooks: [user] }])
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })

  // Why POSIX only: the expected bytes spell the key the way a POSIX path is written.
  it.skipIf(process.platform === 'win32')(
    'rewrites only the moved blocks, carrying each body verbatim and computing nothing',
    () => {
      const orca = command('orca-hook')
      const user = command('user-hook')
      const other = command('other-event-hook')
      const userBody =
        'trusted_hash = "sha256:written-by-codex"\nnote = "a field Orca does not know"'
      const unrelated = [
        'model = "user-model" # the user\'s own comment',
        '',
        '[projects."/work/app"]',
        'trust_level = "trusted"',
        '',
        `[hooks.state."${hooksPath}:post_tool_use:0:0"]`,
        'trusted_hash = "sha256:untouched"',
        ''
      ].join('\n')
      writeFileSync(
        configPath,
        `${unrelated}\n[hooks.state."${hooksPath}:stop:1:0"]\n${userBody}\n`
      )

      mutate(
        { Stop: [{ hooks: [orca] }, { hooks: [user] }], PostToolUse: [{ hooks: [other] }] },
        { Stop: [{ hooks: [user] }], PostToolUse: [{ hooks: [other] }] }
      )

      const after = readFileSync(configPath, 'utf-8')
      expect(after.startsWith(unrelated)).toBe(true)
      expect(after.slice(unrelated.length)).toBe(
        `\n[hooks.state."${hooksPath}:stop:0:0"]\n${userBody}\n`
      )
    }
  )

  // Why: Codex's own writes spell the key path quoted (#22592); a missed spelling here leaves a stale table.
  it.skipIf(process.platform === 'win32')(
    'moves a block in Codex quoted spelling verbatim, leaving no second table behind',
    () => {
      const orca = command('orca-hook')
      const user = command('user-hook')
      const userBody = 'enabled = false\ntrusted_hash = "sha256:written-by-codex"'
      const unrelated = ['model = "user-model"', '', '["hooks"."state"]', ''].join('\n')
      writeFileSync(
        configPath,
        `${unrelated}\n["hooks"."state"."${hooksPath}:stop:1:0"]\n${userBody}\n`
      )

      mutate({ Stop: [{ hooks: [orca] }, { hooks: [user] }] }, { Stop: [{ hooks: [user] }] })

      const after = readFileSync(configPath, 'utf-8')
      expect(after).toBe(`${unrelated}\n[hooks.state."${hooksPath}:stop:0:0"]\n${userBody}\n`)
      expect(readHookTrustEntries(configPath).get(computeTrustKey(stopEntry(0, user)))).toEqual({
        trustedHash: 'sha256:written-by-codex',
        enabled: false
      })
    }
  )
})
