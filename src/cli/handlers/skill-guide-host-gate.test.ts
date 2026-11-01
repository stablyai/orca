import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Settings = { artifactSharingEnabled?: boolean; agentSkillSharingEnabled?: boolean }
type Host = { settings: Settings | Error; isRemote?: boolean } | 'no-access'

const { hostState } = vi.hoisted(() => {
  const state: { host: Host; calls: number } = { host: 'no-access', calls: 0 }
  return { hostState: state }
})

vi.mock('../runtime-client', async () => {
  // Error formatting uses instanceof, so the mock must preserve the production classes.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')

  class RuntimeClient {
    readonly isRemote: boolean
    constructor() {
      if (hostState.host === 'no-access') {
        throw new Error('skills get contacted the host')
      }
      this.isRemote = hostState.host.isRemote ?? false
    }
    async call(method: string): Promise<{ result: { settings: Settings } }> {
      hostState.calls += 1
      if (hostState.host === 'no-access' || method !== 'settings.get') {
        throw new Error(`unexpected ${method}`)
      }
      if (hostState.host.settings instanceof Error) {
        throw hostState.host.settings
      }
      return { result: { settings: hostState.host.settings } }
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

import { BUNDLED_SKILL_GUIDES } from '../bundled-skill-guides'
import { main } from '../index'
import { GUIDE_HOST_CAPABILITIES } from './skill-guide-host-gate'

const PUBLISHING_TEXT = /artifacts share|skills share|## Artifacts|## Skill Sharing/

async function skillsGet(args: string[], host: Host): Promise<{ stdout: string; stderr: string }> {
  hostState.host = host
  let stdout = ''
  let stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(console, 'error').mockImplementation((message) => {
    stderr += String(message)
  })
  await main(['skills', 'get', 'orca-cli', ...args], '/tmp/repo')
  vi.restoreAllMocks()
  return { stdout, stderr }
}

describe('skills get host-capability gating', () => {
  beforeEach(() => {
    hostState.calls = 0
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.exitCode = undefined
  })

  it('only ships closed, unnested blocks that name a known capability', () => {
    const documents = BUNDLED_SKILL_GUIDES.flatMap((guide) => [
      guide.markdown,
      ...guide.references.map((reference) => reference.markdown)
    ])
    for (const markdown of documents) {
      let open: string | null = null
      for (const [, closing, name] of markdown.matchAll(
        /<!-- (\/?)host-capability(?:: ([a-z-]+))? -->/g
      )) {
        if (closing) {
          expect(open).not.toBeNull()
          open = null
          continue
        }
        expect(open).toBeNull()
        expect(GUIDE_HOST_CAPABILITIES).toContain(name)
        open = name
      }
      expect(open).toBeNull()
    }
  })

  it.each<[string, Host]>([
    ['publishing is off', { settings: { artifactSharingEnabled: false } }],
    ['the host omits the settings (headless or older)', { settings: {} }],
    ['the host is unreachable', { settings: new Error('Orca is not running') }]
  ])('withholds publishing from every guide shape when %s', async (_label, host) => {
    const guide = await skillsGet([], host)
    const full = await skillsGet(['--full'], host)
    const listed = await skillsGet(['--references'], host)
    const withheld = await skillsGet(['--reference', 'references/artifacts.md'], host)

    expect(guide.stdout).not.toMatch(PUBLISHING_TEXT)
    expect(full.stdout).not.toMatch(PUBLISHING_TEXT)
    expect(full.stdout).not.toContain('host-capability')
    expect(listed.stdout.trim().split('\n')).toEqual(['automations', 'browser', 'plugins'])
    expect(withheld.stdout).toBe('')
    expect(withheld.stderr).toContain('turned off on this host')
  })

  it('serves publishing guidance when the host has it on, asking the host once', async () => {
    const host: Host = {
      settings: { artifactSharingEnabled: true, agentSkillSharingEnabled: true }
    }
    const full = await skillsGet(['--full'], host)
    expect(hostState.calls).toBe(1)
    const listed = await skillsGet(['--references'], host)

    expect(full.stdout).toContain('## Artifacts')
    expect(full.stdout).toContain('ORCA artifacts share <file> --json')
    expect(full.stdout).toContain('ORCA skills share --skill')
    expect(full.stdout).not.toContain('host-capability')
    expect(listed.stdout.trim().split('\n')).toEqual([
      'artifacts',
      'automations',
      'browser',
      'plugins',
      'skill-sharing'
    ])
  })

  it.each<[string, Host, Record<string, string>]>([
    [
      'a remote runtime',
      {
        settings: { artifactSharingEnabled: true, agentSkillSharingEnabled: true },
        isRemote: true
      },
      {}
    ],
    [
      'a forwarded invocation',
      { settings: { artifactSharingEnabled: true, agentSkillSharingEnabled: true } },
      { ORCA_CLI_CWD: '/remote/repo' }
    ]
  ])('withholds skill sharing from %s, where skills share refuses', async (_label, host, env) => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value)
    }
    const guide = await skillsGet([], host)

    expect(guide.stdout).toContain('## Artifacts')
    expect(guide.stdout).not.toContain('## Skill Sharing')
  })

  it('serves an ungated reference without contacting the host', async () => {
    const { stdout, stderr } = await skillsGet(['--reference', 'browser'], 'no-access')

    expect(stderr).toBe('')
    expect(stdout.length).toBeGreaterThan(0)
  })
})
