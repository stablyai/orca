import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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
  repoPath: string
  status: string
}
const runtimes = vi.hoisted((): { list: FakeRuntime[] } => ({ list: [] }))
vi.mock('../../../shared/ephemeral-vm-runtime-store', () => ({
  listEphemeralVmRuntimes: () => runtimes.list
}))

let dir: string
let local: AgentConfigHomes
let host: AgentConfigHomes
let hostProject: string
let localRepo: string
let calls: { method: string; params: unknown }[]

function put(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mode) {
    chmodSync(path, mode)
  }
}

function homesUnder(root: string): AgentConfigHomes {
  return { home: root, claudeDir: join(root, '.claude'), codexDir: join(root, '.codex') }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloud-agent-config-'))
  local = homesUnder(join(dir, 'mac'))
  host = homesUnder(join(dir, 'vm'))
  localRepo = join(dir, 'mac-repo')
  hostProject = join(dir, 'vm-project')
  mkdirSync(localRepo, { recursive: true })
  mkdirSync(hostProject, { recursive: true })
  execFileSync('git', ['init', '-q', hostProject])
  calls = []
  runtimes.list = [
    {
      runtimeEnvironmentId: 'env-1',
      recipe: { provider: 'orca-cloud' },
      repoPath: localRepo,
      // Not running, so turning sync on doesn't start its own sync under each test.
      status: 'stopped'
    }
  ]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function create(patch: { outdated?: boolean } = {}) {
  const statuses: AgentConfigSyncStatus[] = []
  const hostDeps = { homes: host, projectPath: hostProject, ledgerDir: join(dir, 'vm-userdata') }
  const sync = createCloudAgentConfigSync({
    userDataPath: join(dir, 'mac-userdata'),
    broadcast: (status) => statuses.push(status),
    readLocal: (repoPath) =>
      readLocalAgentConfig({ homes: local, repoPath, trackedPaths: async () => new Set() }),
    // The wire schemas run here as they do in orcad, so the test also checks what crosses.
    call: async (_environmentId, method, params) => {
      calls.push({ method, params })
      if (patch.outdated) {
        throw Object.assign(new Error('nope'), { code: 'method_not_found' })
      }
      if (method === AGENT_CONFIG_SYNC_PLAN_METHOD) {
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
  return { sync, statuses }
}

const outcomes = (status: AgentConfigSyncStatus | null) =>
  Object.fromEntries((status?.rows ?? []).map((row) => [row.key, row.outcome ?? row.skipReason]))

describe('cloud agent config sync, desktop to host', () => {
  it('stays off on connect until the user turns it on, then copies skills and commands', async () => {
    put(join(local.claudeDir, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nShip.')
    put(join(local.claudeDir, 'skills', 'deploy', 'run.sh'), '#!/bin/sh\n', 0o755)
    put(join(local.claudeDir, 'commands', 'review.md'), 'Review $ARGUMENTS')
    const { sync } = create()
    expect(await sync.sync('env-1', 'connect')).toBeNull()
    expect(calls).toEqual([])

    sync.setPreferences({ autoSync: true })
    const status = await sync.sync('env-1', 'connect')
    expect(status?.error).toBeNull()
    expect(outcomes(status)).toEqual({
      'user:claude-skill:deploy': 'added',
      'user:claude-command:review': 'added'
    })
    expect(readFileSync(join(host.claudeDir, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toContain(
      'Ship.'
    )
    expect(statSync(join(host.claudeDir, 'skills', 'deploy', 'run.sh')).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(host.claudeDir, 'commands', 'review.md'), 'utf8')).toBe(
      'Review $ARGUMENTS'
    )
  })

  it('sends nothing the host already has, updates its own copies and removes what was dropped', async () => {
    put(join(local.claudeDir, 'skills', 'a', 'SKILL.md'), 'one')
    put(join(local.claudeDir, 'skills', 'b', 'SKILL.md'), 'bee')
    const { sync } = create()
    sync.setPreferences({ autoSync: true })
    await sync.sync('env-1', 'manual')

    calls = []
    expect(outcomes(await sync.sync('env-1', 'manual'))).toEqual({
      'user:claude-skill:a': 'unchanged',
      'user:claude-skill:b': 'unchanged'
    })
    expect(calls.map((call) => call.method)).toEqual([AGENT_CONFIG_SYNC_PLAN_METHOD])

    put(join(local.claudeDir, 'skills', 'a', 'SKILL.md'), 'two')
    rmSync(join(local.claudeDir, 'skills', 'b'), { recursive: true })
    expect(outcomes(await sync.sync('env-1', 'manual'))).toEqual({
      'user:claude-skill:a': 'updated'
    })
    expect(readFileSync(join(host.claudeDir, 'skills', 'a', 'SKILL.md'), 'utf8')).toBe('two')
    expect(existsSync(join(host.claudeDir, 'skills', 'b'))).toBe(false)
  })

  it('never touches items made or edited in the sandbox', async () => {
    put(join(local.claudeDir, 'skills', 'mine', 'SKILL.md'), 'from the mac')
    put(join(local.claudeDir, 'skills', 'edited', 'SKILL.md'), 'from the mac')
    put(join(host.claudeDir, 'skills', 'mine', 'SKILL.md'), 'made in the sandbox')
    const { sync } = create()
    sync.setPreferences({ autoSync: true })
    expect(outcomes(await sync.sync('env-1', 'manual'))).toEqual({
      'user:claude-skill:mine': 'kept-host',
      'user:claude-skill:edited': 'added'
    })
    put(join(host.claudeDir, 'skills', 'edited', 'SKILL.md'), 'changed in the sandbox')
    rmSync(join(local.claudeDir, 'skills', 'edited'), { recursive: true })
    await sync.sync('env-1', 'manual')
    expect(readFileSync(join(host.claudeDir, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe(
      'made in the sandbox'
    )
    expect(readFileSync(join(host.claudeDir, 'skills', 'edited', 'SKILL.md'), 'utf8')).toBe(
      'changed in the sandbox'
    )
  })

  it('shares skills and commands across agents only when asked, keeping each agent’s own', async () => {
    put(join(local.claudeDir, 'skills', 'deploy', 'SKILL.md'), 'claude deploy')
    put(join(local.claudeDir, 'skills', 'both', 'SKILL.md'), 'claude both')
    put(join(local.home, '.agents', 'skills', 'both', 'SKILL.md'), 'codex both')
    put(join(local.home, '.agents', 'skills', 'lint', 'SKILL.md'), 'codex lint')
    put(join(local.claudeDir, 'commands', 'review.md'), 'review')
    put(join(local.claudeDir, 'commands', 'ns', 'deep.md'), 'namespaced')
    put(join(local.codexDir, 'prompts', 'fix.md'), 'fix')
    const { sync } = create()
    sync.setPreferences({ autoSync: true })
    await sync.sync('env-1', 'manual')
    expect(existsSync(join(host.home, '.agents', 'skills', 'deploy'))).toBe(false)

    sync.setPreferences({ shareAcrossAgents: true })
    const status = await sync.sync('env-1', 'manual')
    const copies = status?.rows.filter((row) => row.convertedFrom).map((row) => row.key)
    expect(copies?.sort()).toEqual([
      'user:agents-skill:deploy',
      'user:claude-command:fix',
      'user:claude-skill:lint',
      'user:codex-prompt:review'
    ])
    expect(readFileSync(join(host.home, '.agents', 'skills', 'deploy', 'SKILL.md'), 'utf8')).toBe(
      'claude deploy'
    )
    expect(readFileSync(join(host.home, '.agents', 'skills', 'both', 'SKILL.md'), 'utf8')).toBe(
      'codex both'
    )
    expect(readFileSync(join(host.codexDir, 'prompts', 'review.md'), 'utf8')).toBe('review')
    expect(readFileSync(join(host.claudeDir, 'commands', 'fix.md'), 'utf8')).toBe('fix')
    expect(existsSync(join(host.codexDir, 'prompts', 'deep.md'))).toBe(false)

    // Turning an original off takes its copy with it.
    sync.setItemIncluded('user:claude-skill:deploy', false)
    await sync.sync('env-1', 'manual')
    expect(existsSync(join(host.claudeDir, 'skills', 'deploy'))).toBe(false)
    expect(existsSync(join(host.home, '.agents', 'skills', 'deploy'))).toBe(false)
  })

  it('puts untracked project items in the workspace and keeps them out of its git status', async () => {
    put(join(localRepo, '.claude', 'skills', 'proj', 'SKILL.md'), 'project skill')
    const { sync } = create()
    sync.setPreferences({ autoSync: true })
    expect(outcomes(await sync.sync('env-1', 'manual'))).toEqual({
      'project:claude-skill:proj': 'added'
    })
    expect(readFileSync(join(hostProject, '.claude', 'skills', 'proj', 'SKILL.md'), 'utf8')).toBe(
      'project skill'
    )
    const exclude = readFileSync(join(hostProject, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n')).toContain('/.claude/skills/proj/')
    const porcelain = execFileSync('git', ['-C', hostProject, 'status', '--porcelain'], {
      encoding: 'utf8'
    })
    expect(porcelain).toBe('')
  })

  it('says the sandbox is outdated when its Orca has no skill sync', async () => {
    put(join(local.claudeDir, 'skills', 'a', 'SKILL.md'), 'x')
    const { sync } = create({ outdated: true })
    const status = await sync.sync('env-1', 'manual')
    expect(status?.error).toBe('host-outdated')
    expect(status?.rows.map((row) => row.state)).toEqual(['pending'])
  })

  it('syncs running workspaces as soon as sync is turned on', async () => {
    put(join(local.claudeDir, 'skills', 'a', 'SKILL.md'), 'x')
    runtimes.list[0].status = 'running'
    const { sync, statuses } = create()
    sync.setPreferences({ autoSync: true })
    await vi.waitFor(() =>
      expect(statuses.some((status) => status.lastSyncedAt !== null)).toBe(true)
    )
    expect(existsSync(join(host.claudeDir, 'skills', 'a', 'SKILL.md'))).toBe(true)
  })

  it('answers null for workspaces that are not Orca Cloud', async () => {
    const { sync } = create()
    expect(await sync.getStatus('env-other')).toBeNull()
    expect(await sync.sync('env-other', 'manual')).toBeNull()
  })
})
