import { generationArgumentText } from '../../shared/source-control/ai/generation/generation-argument'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterEach, expect, it, vi } from 'vitest'
import { planCommitMessageGeneration } from '../../shared/source-control/ai/generation/commit-message-plan'
import { prepareSourceControlReadOnlyPlan } from './source-control-read-only-policy'
import { stageLocalPromptFiles } from './source-control-prompt-files'
import './source-control-local-generation'
import './source-control-generation-lanes'

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock('./source-control-policy-probe', () => ({ runSourceControlPolicyProbe: probe }))
const owned: string[] = []
afterEach(async () => {
  probe.mockReset()
  await Promise.all(
    owned.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})
async function directory() {
  const result = await mkdtemp(join(tmpdir(), 'orca-policy-test-'))
  owned.push(result)
  return result
}
function planned(agentId: 'codex' | 'kimi' | 'antigravity', agentArgs?: string) {
  const result = planCommitMessageGeneration(
    { agentId, model: agentId === 'codex' ? 'gpt-5.4-mini' : 'default', agentArgs },
    'Name this chat'
  )
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.plan
}
const spawnAgent = vi.fn(() => {
  throw new Error('Unexpected semantic process')
})

it('disables every effective Codex MCP name, including dotted names, after recipe overrides', async () => {
  probe.mockReturnValue({
    result: Promise.resolve({
      stdout:
        '[{"name":"a.b","enabled":true,"transport":{"type":"stdio"}},{"name":"second","enabled":true}]',
      stderr: 'Warning: optional update unavailable'
    }),
    processClosed: Promise.resolve()
  })
  const plan = await prepareSourceControlReadOnlyPlan({
    agentId: 'codex',
    plan: planned(
      'codex',
      '-c features.apps=true -c features.plugins=true -c mcp_servers.a.enabled=true --profile review'
    ),
    target: { kind: 'local', cwd: '/workspace', env: { CODEX_HOME: '/bound-account' } },
    signal: new AbortController().signal,
    spawnAgent
  }).result
  expect(probe.mock.calls[0][0]).toMatchObject({
    target: { cwd: '/workspace', env: { CODEX_HOME: '/bound-account' } },
    args: [
      '-c',
      'features.apps=true',
      '-c',
      'features.plugins=true',
      '-c',
      'mcp_servers.a.enabled=true',
      '--profile',
      'review',
      '-c',
      'features.plugins=false',
      '-c',
      'features.apps=false',
      'mcp',
      'list',
      '--json'
    ]
  })
  expect(plan.args.slice(-6)).toEqual([
    '-c',
    'features.plugins=false',
    '-c',
    'features.apps=false',
    '-c',
    'mcp_servers={"a.b"={enabled=false},"second"={enabled=false}}'
  ])
  probe.mockReturnValue({
    result: Promise.reject(new Error('Unsupported configuration query')),
    processClosed: Promise.resolve()
  })
  await expect(
    prepareSourceControlReadOnlyPlan({
      agentId: 'codex',
      plan: planned('codex'),
      target: { kind: 'local', cwd: '/workspace' },
      signal: new AbortController().signal,
      spawnAgent
    }).result
  ).rejects.toThrow('Unsupported configuration query')
})

it('copies an explicit Kimi profile with its prompt and identity preserved and an empty tool policy', async () => {
  const cwd = await directory()
  await writeFile(
    join(cwd, 'reviewer.md'),
    '---\nname: careful-reviewer\ndescription: Review code\ntools: ["*"]\ndisallowedTools: [read]\nsubagents: [explore]\n---\nReview precisely. ${base_prompt}\n'
  )
  const policy = await prepareSourceControlReadOnlyPlan({
    agentId: 'kimi',
    plan: planned('kimi', '--agent-file reviewer.md'),
    target: { kind: 'local', cwd },
    signal: new AbortController().signal,
    spawnAgent
  }).result
  const plan = stageLocalPromptFiles(policy, (directory) => owned.push(directory))
  const flag = plan.args.indexOf('--agent-file')
  const content = await readFile(generationArgumentText(plan.args[flag + 1]), 'utf8')
  const sections = content.split('---\n')
  expect(content.startsWith('---\n')).toBe(true)
  expect(parseYaml(sections[1])).toEqual({
    name: 'careful-reviewer',
    description: 'Review code',
    tools: [],
    subagents: ['explore']
  })
  expect(sections[2]).toBe('Review precisely. ${base_prompt}\n')
  expect(await readFile(join(cwd, 'reviewer.md'), 'utf8')).toContain('tools: ["*"]')
})

it('composes agy session settings without losing existing read denies or selected recipe fields', async () => {
  probe.mockReturnValue({
    result: Promise.resolve({
      stdout: '',
      stderr:
        '  --settings  Settings for this session only, never saved: a JSON object of settings.json keys, inline or as a file path'
    }),
    processClosed: Promise.resolve()
  })
  const cwd = await directory()
  await writeFile(
    join(cwd, 'settings.json'),
    '\uFEFF{"customSetting":"retained","permissions":{"deny":["read_file(secret/*)"],"ask":["read_file(review/*)"]}}'
  )
  const policy = await prepareSourceControlReadOnlyPlan({
    agentId: 'antigravity',
    plan: planned(
      'antigravity',
      '--settings settings.json --settings \'{"permissions":{"deny":["read_file(other/*)"]},"anotherSetting":true}\' --agent review --effort high'
    ),
    target: { kind: 'local', cwd },
    signal: new AbortController().signal,
    spawnAgent
  }).result
  const value = generationArgumentText(policy.args[policy.args.indexOf('--settings') + 1])
  expect(JSON.parse(value)).toEqual({
    customSetting: 'retained',
    anotherSetting: true,
    toolPermission: 'request-review',
    allowNonWorkspaceAccess: true,
    permissions: {
      allow: ['read_file(*)'],
      ask: ['read_file(review/*)'],
      deny: [
        'read_file(secret/*)',
        'read_file(other/*)',
        'write_file(*)',
        'command(*)',
        'mcp(*)',
        'read_url(*)',
        'execute_url(*)'
      ]
    }
  })
  expect(policy.args).toContain('review')
  expect(policy.args).toContain('high')
  expect(await readFile(join(cwd, 'settings.json'), 'utf8')).not.toContain('write_file')
})
