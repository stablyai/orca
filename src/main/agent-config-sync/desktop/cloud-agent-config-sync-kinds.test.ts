import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_CONFIG_SYNC_PLAN_METHOD,
  AGENT_CONFIG_SYNC_PUT_METHOD,
  AgentConfigSyncPlanParams,
  AgentConfigSyncPutParams,
  type AgentConfigSyncStatus
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import type { AgentConfigHomes } from '../agent-config-roots'
import { planHostAgentConfigSync, putHostAgentConfig } from '../host/host-agent-config-sync'
import { createCloudAgentConfigSync } from './cloud-agent-config-sync'
import { readLocalAgentConfig } from './local-agent-config-read'

type FakeRuntime = {
  runtimeEnvironmentId: string
  recipe: { provider: string }
  repoPath: string | null
  status: string
}
const runtimes = vi.hoisted((): { list: FakeRuntime[] } => ({ list: [] }))
vi.mock('../../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: () => runtimes.list
}))

let dir: string
let local: AgentConfigHomes
let host: AgentConfigHomes

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const homesUnder = (root: string): AgentConfigHomes => ({
  home: root,
  claudeDir: join(root, '.claude'),
  codexDir: join(root, '.codex')
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloud-agent-config-kinds-'))
  local = homesUnder(join(dir, 'mac'))
  host = homesUnder(join(dir, 'vm'))
  runtimes.list = [
    {
      runtimeEnvironmentId: 'env-1',
      recipe: { provider: 'orca-cloud' },
      repoPath: null,
      status: 'stopped'
    }
  ]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** `olderHost`: a sandbox whose Orca predates `kinds` (strict params reject the unknown field). */
function create(olderHost: boolean | 'part1' = false) {
  const hostDeps = { homes: host, projectPath: null, ledgerDir: join(dir, 'vm-userdata') }
  const sync = createCloudAgentConfigSync({
    userDataPath: join(dir, 'mac-userdata'),
    broadcast: () => {},
    readLocal: (repoPath) =>
      readLocalAgentConfig({ homes: local, repoPath, trackedPaths: async () => new Set() }),
    call: async (_environmentId, method, params) => {
      if (method === AGENT_CONFIG_SYNC_PLAN_METHOD) {
        const kinds =
          typeof params === 'object' && params !== null && 'kinds' in params ? params.kinds : null
        if (olderHost === true && kinds) {
          throw Object.assign(new Error('Unrecognized key: "kinds"'), { code: 'invalid_argument' })
        }
        // A sandbox on the SK1 part 1 image: knows subagents and memory, not settings.
        if (olderHost === 'part1' && Array.isArray(kinds) && kinds.includes('claude-settings')) {
          throw Object.assign(new Error('Invalid enum value'), { code: 'invalid_argument' })
        }
        return planHostAgentConfigSync(AgentConfigSyncPlanParams.parse(params), hostDeps)
      }
      if (method === AGENT_CONFIG_SYNC_PUT_METHOD) {
        return putHostAgentConfig(AgentConfigSyncPutParams.parse(params), hostDeps)
      }
      throw new Error(`unexpected ${method}`)
    },
    now: () => 1_000
  })
  mkdirSync(join(dir, 'mac-userdata'), { recursive: true })
  return sync
}

const outcomes = (status: AgentConfigSyncStatus | null) =>
  Object.fromEntries((status?.rows ?? []).map((row) => [row.key, row.outcome ?? row.skipReason]))

describe('subagents, output styles and memory', () => {
  it('syncs subagents and output styles, and keeps memory off until the user turns it on', async () => {
    put(join(local.claudeDir, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview code.')
    put(join(local.claudeDir, 'output-styles', 'terse.md'), '---\nname: terse\n---\nBe brief.')
    put(join(local.claudeDir, 'CLAUDE.md'), '# My rules\nPrefer pnpm.')
    put(join(local.codexDir, 'AGENTS.md'), '# Codex rules')
    const sync = create()
    sync.setPreferences({ autoSync: true })
    expect(outcomes(await sync.sync('env-1', 'manual'))).toEqual({
      'user:claude-agent:reviewer': 'added',
      'user:claude-output-style:terse': 'added',
      'user:claude-memory:CLAUDE': 'turned-off',
      'user:codex-memory:AGENTS': 'turned-off'
    })
    expect(readFileSync(join(host.claudeDir, 'agents', 'reviewer.md'), 'utf8')).toContain('Review')
    expect(existsSync(join(host.claudeDir, 'CLAUDE.md'))).toBe(false)

    sync.setItemIncluded('user:claude-memory:CLAUDE', true)
    expect(sync.getPreferences().optedIn).toEqual(['user:claude-memory:CLAUDE'])
    const status = await sync.sync('env-1', 'manual')
    // Turning it on already re-synced this workspace (it had synced before); this run finds it there.
    expect(outcomes(status)['user:claude-memory:CLAUDE']).toBe('unchanged')
    expect(readFileSync(join(host.claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# My rules\nPrefer pnpm.')
    // Codex memory stays per agent and off.
    expect(existsSync(join(host.codexDir, 'AGENTS.md'))).toBe(false)

    // Turning memory back off removes the copy this computer wrote.
    sync.setItemIncluded('user:claude-memory:CLAUDE', false)
    await sync.sync('env-1', 'manual')
    expect(existsSync(join(host.claudeDir, 'CLAUDE.md'))).toBe(false)
  })

  it('never sends memory that holds a key, and flags imports of files outside its folder', async () => {
    put(join(local.claudeDir, 'CLAUDE.md'), 'Use @~/notes/private.md and @RTK.md\nmail @alice')
    put(join(local.codexDir, 'AGENTS.md'), 'token ghp_0123456789abcdefghijABCDEFGHIJ0123456789')
    put(join(local.claudeDir, 'agents', 'deployer.md'), 'Use AKIAABCDEFGHIJKLMNOP to deploy.')
    put(join(local.claudeDir, 'output-styles', 'stripe.md'), 'Key sk_live_0123456789abcdefghijklmn')
    const sync = create()
    const status = await sync.getStatus('env-1')
    const rows = Object.fromEntries((status?.rows ?? []).map((row) => [row.name, row]))
    expect(rows.CLAUDE.localRefs).toBe(1)
    expect(rows.AGENTS.skipReason).toBe('secret')
    expect(rows.deployer.skipReason).toBe('secret')
    expect(rows.stripe.skipReason).toBe('secret')
  })

  it('gives an older sandbox the original kinds and marks the newer ones as needing a newer workspace', async () => {
    put(join(local.claudeDir, 'skills', 'deploy', 'SKILL.md'), 'Ship.')
    put(join(local.claudeDir, 'agents', 'reviewer.md'), 'Review code.')
    const sync = create(true)
    sync.setPreferences({ autoSync: true })
    const status = await sync.sync('env-1', 'manual')
    expect(status?.error).toBeNull()
    expect(outcomes(status)).toEqual({
      'user:claude-skill:deploy': 'added',
      'user:claude-agent:reviewer': 'host-outdated'
    })
    expect(existsSync(join(host.claudeDir, 'skills', 'deploy', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(host.claudeDir, 'agents', 'reviewer.md'))).toBe(false)
  })

  it('an older desktop (no kinds) never removes subagents a newer one wrote', async () => {
    const hostDeps = { homes: host, projectPath: null, ledgerDir: join(dir, 'vm-userdata') }
    put(join(local.claudeDir, 'agents', 'reviewer.md'), 'Review code.')
    const sync = create()
    sync.setPreferences({ autoSync: true })
    await sync.sync('env-1', 'manual')
    expect(existsSync(join(host.claudeDir, 'agents', 'reviewer.md'))).toBe(true)
    // Same computer, older app: plans the legacy kinds only and sends no `kinds`.
    const syncer = readFileSync(join(dir, 'mac-userdata', 'mcp-sync-syncer-id'), 'utf8').trim()
    const plan = await planHostAgentConfigSync({ syncer, items: [] }, hostDeps)
    expect(plan.removed).toBe(0)
    expect(existsSync(join(host.claudeDir, 'agents', 'reviewer.md'))).toBe(true)
  })

  it('merges allowlisted settings into the sandbox settings.json when turned on, and takes them back', async () => {
    put(
      join(local.claudeDir, 'settings.json'),
      JSON.stringify({
        model: 'opus',
        env: { SECRET: 'x' },
        hooks: { Stop: [] },
        permissions: { allow: ['Bash(npm test:*)', 'Edit(/Users/me/**)'] }
      })
    )
    put(
      join(host.claudeDir, 'settings.json'),
      JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } })
    )
    const sync = create()
    sync.setPreferences({ autoSync: true })
    const off = await sync.sync('env-1', 'manual')
    expect(outcomes(off)['user:claude-settings:settings']).toBe('turned-off')

    sync.setItemIncluded('user:claude-settings:settings', true)
    await sync.sync('env-1', 'manual')
    expect(JSON.parse(readFileSync(join(host.claudeDir, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
      model: 'opus',
      permissions: { allow: ['Bash(ls)', 'Bash(npm test:*)'] }
    })

    sync.setItemIncluded('user:claude-settings:settings', false)
    await sync.sync('env-1', 'manual')
    expect(JSON.parse(readFileSync(join(host.claudeDir, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark',
      permissions: { allow: ['Bash(ls)'] }
    })
  })

  it('steps down one protocol generation for a sandbox that knows subagents but not settings', async () => {
    put(join(local.claudeDir, 'agents', 'reviewer.md'), 'Review code.')
    put(join(local.claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }))
    const sync = create('part1')
    sync.setPreferences({ autoSync: true })
    sync.setItemIncluded('user:claude-settings:settings', true)
    const status = await sync.sync('env-1', 'manual')
    expect(outcomes(status)).toEqual({
      'user:claude-agent:reviewer': 'added',
      'user:claude-settings:settings': 'host-outdated'
    })
    expect(existsSync(join(host.claudeDir, 'agents', 'reviewer.md'))).toBe(true)
  })
})
