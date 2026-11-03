import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CustomAcpAgentsConfig } from './custom-acp-agent-config'
import { customAcpLaunchSpec, loadCustomAcpLaunchSpecs } from './custom-acp-launch-specs'
import { resolveAcpLaunchInvocation } from './acp-structured-launch-resolution'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import { supportsAcpStructuredLocation } from './acp-structured-location-support'
import { agentChatPermissionModes } from '../../shared/agent-chat-permission-support'
import { GENERIC_ACP_DIALECT } from './acp-dialects/acp-dialect'

const folders: string[] = []
const config = () => ({
  apiVersion: 1,
  agents: [
    {
      id: 'custom-reviewer',
      name: 'Company reviewer',
      command: 'review-adapter',
      args: ['--acp', 'two words', '$(never-run)'],
      env: { ENDPOINT: 'https://example.invalid' },
      account: { variable: 'REVIEWER_HOME', directory: join(tmpdir(), 'reviewer-account') }
    }
  ]
})

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

describe('versioned custom ACP configuration', () => {
  it.each([
    ['a future API version', { ...config(), apiVersion: 2 }],
    ['a built-in ID', { ...config(), agents: [{ ...config().agents[0], id: 'codex' }] }],
    ['a path ID', { ...config(), agents: [{ ...config().agents[0], id: 'custom-../bad' }] }],
    ['duplicate IDs', { ...config(), agents: [...config().agents, ...config().agents] }],
    ['unknown executable code', { ...config(), module: 'adapter.js' }],
    ['a NUL argument', { ...config(), agents: [{ ...config().agents[0], args: ['a\0b'] }] }],
    [
      'a relative account',
      {
        ...config(),
        agents: [{ ...config().agents[0], account: { variable: 'HOME', directory: 'relative' } }]
      }
    ],
    [
      'an account overwrite',
      { ...config(), agents: [{ ...config().agents[0], env: { REVIEWER_HOME: '/other' } }] }
    ]
  ])('refuses %s before an executable is registered', (_name, value) => {
    expect(CustomAcpAgentsConfig.safeParse(value).success).toBe(false)
  })

  it('loads only an explicit, bounded file and never includes its secrets in errors', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'orca-custom-config-'))
    folders.push(folder)
    const path = join(folder, 'adapters.json')
    const warn = vi.fn()
    await writeFile(path, JSON.stringify(config()))
    expect(loadCustomAcpLaunchSpecs(path, warn).map((spec) => spec.agent)).toEqual([
      'custom-reviewer'
    ])
    expect(loadCustomAcpLaunchSpecs('', warn)).toEqual([])
    expect(loadCustomAcpLaunchSpecs('adapters.json', warn)).toEqual([])
    expect(loadCustomAcpLaunchSpecs(folder, warn)).toEqual([])
    await writeFile(path, JSON.stringify({ secret: 'private-key-value' }))
    expect(loadCustomAcpLaunchSpecs(path, warn)).toEqual([])
    await writeFile(path, ' '.repeat(256 * 1024 + 1))
    expect(loadCustomAcpLaunchSpecs(path, warn)).toEqual([])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-key-value')
  })

  it('pins the configured account and resolves literal argv without a shell or built-in overrides', async () => {
    const parsed = CustomAcpAgentsConfig.parse(config()).agents[0]!
    const spec = customAcpLaunchSpec(parsed)
    const home = await spec.account.resolve({
      launchEnv: { REVIEWER_HOME: '/unrelated' },
      stateDirectory: '/state'
    })
    expect(home).toEqual({ variable: 'REVIEWER_HOME', path: parsed.account.directory })
    const result = await resolveAcpLaunchInvocation(spec, home, {
      resolveEnvironment: async () => ({ PATH: '/bin', REVIEWER_HOME: '/unrelated' }),
      resolveCommand: () => '/opt/review-adapter',
      dataDirectory: '/orca-state'
    })
    expect(result.command).toBe('/opt/review-adapter')
    expect(result.env).toMatchObject({
      REVIEWER_HOME: parsed.account.directory,
      ENDPOINT: parsed.env.ENDPOINT
    })
    expect(spec.args({ fullAccess: false, pluginDir: null })).toEqual(parsed.args)
    expect(spec.dialect).toBe(GENERIC_ACP_DIALECT)
    expect(acpStructuredAgentDefinition(spec)).toMatchObject({
      agent: parsed.id,
      displayName: parsed.name,
      handleTransport: 'acp',
      accountHomeVariable: 'REVIEWER_HOME',
      capabilities: {
        rewind: false,
        compact: false,
        steering: 'queue',
        approvalEnforcement: 'orca'
      }
    })
    expect(agentChatPermissionModes(parsed.id)?.modes).toEqual(['ask', 'full-access'])
    const location = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    } as const
    expect(supportsAcpStructuredLocation(spec, location)).toBe(true)
    expect(supportsAcpStructuredLocation(spec, { ...location, executionHostId: 'ssh:box' })).toBe(
      false
    )
    expect(supportsAcpStructuredLocation(spec, { ...location, wslDistro: 'Ubuntu' })).toBe(false)
  })
})
