import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import { enableProvisionedCodexManagedHooks } from './codex-managed-hook-provision'
import {
  computeTrustKey,
  computeTrustedHash,
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

describe('managed Codex account hook provision', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true })
    }
  })

  function fixture(command = getManagedCommand(getManagedScriptPath())): {
    home: string
    entries: CodexTrustEntry[]
    projectKey: string
  } {
    const home = mkdtempSync(join(tmpdir(), 'orca-managed-hook-provision-'))
    homes.push(home)
    const configPath = join(home, 'hooks.json')
    const sourcePath = getCodexExplicitHomeHookSourcePath(configPath)
    const entries = CODEX_EVENTS.map((event) => ({
      sourcePath,
      eventLabel: CODEX_EVENT_LABEL[event],
      groupIndex: 0,
      handlerIndex: 0,
      command,
      timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
    }))
    const hooks = Object.fromEntries(
      CODEX_EVENTS.map((event) => [event, [{ hooks: [{ command }] }]])
    )
    writeFileSync(configPath, JSON.stringify({ hooks }))
    const projectEntry: CodexTrustEntry = {
      sourcePath: join(home, 'project', '.codex', 'hooks.json'),
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'project-review-required'
    }
    upsertHookTrustEntries(join(home, 'config.toml'), [
      ...entries.map((entry) => ({
        ...entry,
        trustedHash: computeTrustedHash(entry),
        enabled: false
      })),
      { ...projectEntry, trustedHash: computeTrustedHash(projectEntry), enabled: false }
    ])
    return { home, entries, projectKey: computeTrustKey(projectEntry) }
  }

  it('enables exactly Orca entries and is idempotent', () => {
    const { home, entries, projectKey } = fixture()
    const tomlPath = join(home, 'config.toml')
    enableProvisionedCodexManagedHooks(home)
    const first = readFileSync(tomlPath, 'utf-8')
    const states = readHookTrustEntries(tomlPath)
    for (const entry of entries) {
      expect(states.get(computeTrustKey(entry))).toEqual({
        trustedHash: computeTrustedHash(entry),
        enabled: true
      })
    }
    expect(states.get(projectKey)?.enabled).toBe(false)
    enableProvisionedCodexManagedHooks(home)
    expect(readFileSync(tomlPath, 'utf-8')).toBe(first)
  })

  it('refuses to enable a lookalike command', () => {
    const { home, entries } = fixture('/tmp/evil/agent-hooks/codex-hook.sh.evil')
    const tomlPath = join(home, 'config.toml')
    const before = readFileSync(tomlPath, 'utf-8')
    expect(() => enableProvisionedCodexManagedHooks(home)).toThrow('missing for SessionStart')
    expect(readFileSync(tomlPath, 'utf-8')).toBe(before)
    expect(readHookTrustEntries(tomlPath).get(computeTrustKey(entries[0]))?.enabled).toBe(false)
  })
})
