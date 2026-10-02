import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import {
  escapeTomlString,
  getCodexExplicitHomeHookSourcePath,
  upsertHookTrustEntriesInContent
} from './config-toml-trust'
import { parseHookStateTomlHeaderKey } from './config-toml-syntax'
import { getTomlSections } from './config-toml-runtime-owned-sections'
import { hookTrustHeader, setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CodexHookService } from './hook-service'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

// Why (#22592): Codex may write any of these; each names the same hooks.state table.
const HOOK_STATE_SPELLINGS = [
  ['bare parent', (key: string) => `[hooks.state."${escapeTomlString(key)}"]`],
  ['fully quoted', (key: string) => `["hooks"."state"."${escapeTomlString(key)}"]`],
  ['literal leaf', (key: string) => `[hooks.state.'${key}']`],
  ['mixed', (key: string) => `[hooks."state"."${escapeTomlString(key)}"]`]
] as const

function seedTrustedSystemUserHook(
  spell: (key: string) => string,
  enabled: boolean
): { trustedHash: string } {
  const systemCodexHome = join(homes.tmpHome, '.codex')
  const systemHooksPath = join(systemCodexHome, 'hooks.json')
  mkdirSync(systemCodexHome, { recursive: true })
  writeFileSync(
    systemHooksPath,
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } })}\n`,
    'utf-8'
  )
  const bareToml = upsertHookTrustEntriesInContent('model = "system-model"\n', [
    {
      sourcePath: systemHooksPath,
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-hook',
      enabled
    }
  ])
  const headerLine = bareToml.split('\n').find((line) => parseHookStateTomlHeaderKey(line) !== null)
  const key = headerLine === undefined ? null : parseHookStateTomlHeaderKey(headerLine)
  const trustedHash = /trusted_hash = "([^"]+)"/.exec(bareToml)?.[1]
  expect(headerLine).toBeDefined()
  expect(key).not.toBeNull()
  expect(trustedHash).toBeDefined()
  writeFileSync(
    join(systemCodexHome, 'config.toml'),
    bareToml.replace(headerLine!, spell(key!)),
    'utf-8'
  )
  return { trustedHash: trustedHash! }
}

function expectNoDuplicateTables(toml: string): void {
  const headers = getTomlSections(toml).map((section) => section.header.replace(/\s+/g, ''))
  expect(new Set(headers).size).toBe(headers.length)
  const hookKeys = headers.flatMap((header) => parseHookStateTomlHeaderKey(header) ?? [])
  expect(new Set(hookKeys).size).toBe(hookKeys.length)
}

describe('CodexHookService user-hook trust spellings', () => {
  describe.each(HOOK_STATE_SPELLINGS)('%s ~/.codex trust', (_name, spell) => {
    it.each([true, false])(
      're-keys trusted_hash and enabled=%s into the runtime CODEX_HOME',
      async (enabled) => {
        const { trustedHash } = seedTrustedSystemUserHook(spell, enabled)

        const service = new CodexHookService()
        expect((await service.install()).state).toBe('installed')
        // Why: the second launch mirrors onto a runtime that already holds the entry.
        expect((await service.install()).state).toBe('installed')

        const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
        const managedHooksPath = join(managedCodexHome, 'hooks.json')
        const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
        expect(runtimeToml).toContain(
          `${hookTrustHeader(`${managedHooksPath}:stop:1:0`)}\nenabled = ${enabled}\ntrusted_hash = "${trustedHash}"`
        )
        expectNoDuplicateTables(runtimeToml)
      }
    )
  })

  it.each(HOOK_STATE_SPELLINGS)(
    'applies ~/.codex enabled=false over a %s runtime copy Codex wrote inside Orca',
    async (_name, spell) => {
      const { trustedHash } = seedTrustedSystemUserHook(HOOK_STATE_SPELLINGS[0][1], false)
      const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
      const managedHooksPath = join(managedCodexHome, 'hooks.json')
      mkdirSync(managedCodexHome, { recursive: true })
      const runtimeKey = `${getCodexExplicitHomeHookSourcePath(managedHooksPath)}:stop:1:0`
      writeFileSync(
        join(managedCodexHome, 'config.toml'),
        `${spell(runtimeKey)}\nenabled = true\ntrusted_hash = "sha256:stale"\n`,
        'utf-8'
      )

      expect((await new CodexHookService().install()).state).toBe('installed')

      const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
      expect(runtimeToml).toContain(
        `${hookTrustHeader(`${managedHooksPath}:stop:1:0`)}\nenabled = false\ntrusted_hash = "${trustedHash}"`
      )
      expect(runtimeToml).not.toContain('sha256:stale')
      expectNoDuplicateTables(runtimeToml)
    }
  )
})
