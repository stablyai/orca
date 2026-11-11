import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentConfigSyncPlanParams,
  AgentConfigSyncPutParams
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { agentConfigDigest } from '../agent-config-digest'
import {
  planHostAgentConfigSync,
  putHostAgentConfig,
  type HostAgentConfigSyncDeps
} from './host-agent-config-sync'

let dir: string
let deps: HostAgentConfigSyncDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-agent-config-'))
  deps = {
    homes: { home: dir, claudeDir: join(dir, '.claude'), codexDir: join(dir, '.codex') },
    projectPath: null,
    ledgerDir: join(dir, 'userData')
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const skillFiles = [{ path: 'SKILL.md', executable: false, bytes: Buffer.from('hello') }]
const digest = agentConfigDigest(skillFiles)
const payload = (patch: Record<string, unknown> = {}) => ({
  scope: 'user' as const,
  kind: 'claude-skill' as const,
  name: 'hello',
  digest,
  files: [{ path: 'SKILL.md', executable: false, base64: Buffer.from('hello').toString('base64') }],
  ...patch
})

describe('host agent config sync', () => {
  it('rejects names and paths that could leave the agent folders', () => {
    for (const name of ['../x', '.hidden', 'a/b', '']) {
      expect(
        AgentConfigSyncPlanParams.safeParse({
          syncer: 's',
          items: [{ scope: 'user', kind: 'claude-skill', name, digest }]
        }).success
      ).toBe(false)
    }
    for (const path of ['../SKILL.md', '/etc/passwd', 'a/../../b', '.git/config']) {
      expect(
        AgentConfigSyncPutParams.safeParse({
          syncer: 's',
          items: [payload({ files: [{ path, executable: false, base64: '' }] })]
        }).success
      ).toBe(false)
    }
    // Codex prompts and old Codex skills have no project scope.
    expect(
      AgentConfigSyncPlanParams.safeParse({
        syncer: 's',
        items: [{ scope: 'project', kind: 'codex-prompt', name: 'x', digest }]
      }).success
    ).toBe(false)
  })

  it('refuses a payload that does not match its digest or lacks SKILL.md', async () => {
    const result = await putHostAgentConfig(
      {
        syncer: 's',
        items: [
          payload({ digest: '0'.repeat(64) }),
          payload({
            name: 'nomain',
            digest: agentConfigDigest([
              { path: 'other.md', executable: false, bytes: Buffer.from('x') }
            ]),
            files: [
              { path: 'other.md', executable: false, base64: Buffer.from('x').toString('base64') }
            ]
          })
        ]
      },
      deps
    )
    expect(result.items).toEqual({
      'user:claude-skill:hello': 'invalid',
      'user:claude-skill:nomain': 'invalid'
    })
    expect(existsSync(join(dir, '.claude', 'skills'))).toBe(false)
  })

  it('leaves a symlinked skill alone and keeps project items out without a workspace', async () => {
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(dir, 'elsewhere'))
    symlinkSync(join(dir, 'elsewhere'), join(dir, '.claude', 'skills', 'hello'))
    const plan = await planHostAgentConfigSync(
      {
        syncer: 's',
        items: [
          { scope: 'user', kind: 'claude-skill', name: 'hello', digest },
          { scope: 'project', kind: 'claude-skill', name: 'proj', digest }
        ]
      },
      deps
    )
    expect(plan.items).toEqual({
      'user:claude-skill:hello': 'kept-host',
      'project:claude-skill:proj': 'no-project'
    })
  })

  it('ignores ledger entries that do not name a valid item', async () => {
    mkdirSync(deps.ledgerDir, { recursive: true })
    writeFileSync(
      join(deps.ledgerDir, 'agent-config-sync-ledger-s.json'),
      JSON.stringify({ version: 1, items: { 'user:claude-skill:../../victim': digest } })
    )
    mkdirSync(join(dir, 'victim'))
    writeFileSync(join(dir, 'victim', 'SKILL.md'), 'hello')
    const plan = await planHostAgentConfigSync({ syncer: 's', items: [] }, deps)
    expect(plan.removed).toBe(0)
    expect(existsSync(join(dir, 'victim', 'SKILL.md'))).toBe(true)
  })

  it('keeps each computer’s items separate', async () => {
    await planHostAgentConfigSync(
      { syncer: 'mac-a', items: [{ scope: 'user', kind: 'claude-skill', name: 'hello', digest }] },
      deps
    )
    await putHostAgentConfig({ syncer: 'mac-a', items: [payload()] }, deps)
    // Another computer that never sent it doesn't remove it.
    const other = await planHostAgentConfigSync({ syncer: 'mac-b', items: [] }, deps)
    expect(other.removed).toBe(0)
    expect(existsSync(join(dir, '.claude', 'skills', 'hello', 'SKILL.md'))).toBe(true)
    const own = await planHostAgentConfigSync({ syncer: 'mac-a', items: [] }, deps)
    expect(own.removed).toBe(1)
    expect(existsSync(join(dir, '.claude', 'skills', 'hello'))).toBe(false)
  })
})
