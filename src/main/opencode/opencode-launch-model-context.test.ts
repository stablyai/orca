import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseOpenCodeLaunchModelContext,
  probeOpenCodeLaunchModelContext
} from './opencode-launch-model-context'
import { resolveOpenCodeLaunchModelConfig } from './opencode-launch-model-config'

const directory = '/private/project'
const snapshot = {
  directory,
  models: {
    location: { directory },
    data: [
      { id: 'one', providerID: 'provider', enabled: true },
      { id: 'disabled', providerID: 'provider', enabled: false }
    ]
  },
  agents: {
    location: { directory },
    data: [
      {
        id: 'reviewer',
        mode: 'primary',
        hidden: false,
        model: { id: 'one', providerID: 'provider' }
      },
      { id: 'build', mode: 'primary', hidden: false },
      { id: 'hidden', mode: 'primary', hidden: true },
      { id: 'child', mode: 'subagent', hidden: false }
    ]
  },
  config: [{ type: 'document', info: { default_agent: 'reviewer' } }],
  defaultModel: {
    location: { directory },
    data: { id: 'one', providerID: 'provider', enabled: true }
  }
}

describe('OpenCode execution-host model context', () => {
  it('uses the configured visible primary and exact enabled provider/model pairs', () => {
    expect(parseOpenCodeLaunchModelContext(snapshot)).toEqual({
      primaryAgent: 'reviewer',
      availableModels: ['provider/one'],
      primaryModel: 'provider/one'
    })
  })

  it('uses actual returned primary ordering and skips hidden agents and children', () => {
    const agents = {
      location: { directory },
      data: [...snapshot.agents.data.slice(2), ...snapshot.agents.data.slice(0, 2)]
    }
    expect(parseOpenCodeLaunchModelContext({ ...snapshot, agents })?.primaryAgent).toBe('reviewer')
    expect(
      parseOpenCodeLaunchModelContext({
        ...snapshot,
        defaultModel: { location: { directory }, data: null }
      })
    ).toBeNull()
  })

  it('refuses an uninitialized, malformed or foreign-location response', () => {
    for (const models of [
      null,
      { location: { directory }, data: [] },
      { location: { directory: '/other' }, data: snapshot.models.data }
    ]) {
      expect(parseOpenCodeLaunchModelContext({ ...snapshot, models })).toBeNull()
    }
    expect(
      parseOpenCodeLaunchModelContext({
        ...snapshot,
        agents: { location: { directory }, data: [] }
      })
    ).toBeNull()
  })
})

describe.skipIf(!process.env.ORCA_REAL_OPENCODE_CLI_TEST)(
  'real current OpenCode model preflight',
  () => {
    it('waits for initialization and verifies a custom primary before and after a private overlay', async () => {
      const executable = process.env.ORCA_REAL_OPENCODE_CLI_TEST
      if (!executable) {
        throw new Error('Real OpenCode executable required')
      }
      const home = await mkdtemp(join(tmpdir(), 'orca-opencode-model-context-'))
      try {
        const env: NodeJS.ProcessEnv = {}
        for (const [key, value] of Object.entries(process.env)) {
          if (!/API_KEY|TOKEN|SECRET|AUTH|CREDENTIAL|OPENCODE_|ORCA_/.test(key)) {
            env[key] = value
          }
        }
        for (const [key, child] of [
          ['HOME', 'home'],
          ['XDG_CONFIG_HOME', 'config'],
          ['XDG_DATA_HOME', 'data'],
          ['XDG_STATE_HOME', 'state'],
          ['XDG_CACHE_HOME', 'cache']
        ]) {
          const path = join(home, child)
          await mkdir(path, { mode: 0o700 })
          env[key] = path
        }
        env.ORCA_BACKGROUND_LAUNCH = '1'
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
          default_agent: 'reviewer',
          model: 'opencode/big-pickle',
          agents: {
            reviewer: { mode: 'primary', system: 'Review only', model: 'opencode/big-pickle' }
          }
        })
        const options = { executable, cwd: process.cwd(), env }
        const before = await probeOpenCodeLaunchModelContext(options)
        expect(before?.primaryAgent).toBe('reviewer')
        expect(before?.primaryModel).toBe('opencode/big-pickle')
        expect(before?.availableModels).toContain('opencode/fledge-alpha-free')
        const config = resolveOpenCodeLaunchModelConfig({
          configContent: env.OPENCODE_CONFIG_CONTENT,
          primaryAgent: before?.primaryAgent ?? '',
          model: 'opencode/fledge-alpha-free'
        })
        expect(config).not.toBeNull()
        const after = await probeOpenCodeLaunchModelContext({
          ...options,
          env: { ...env, OPENCODE_CONFIG_CONTENT: config ?? '' },
          expectedPrimaryAgent: 'reviewer',
          expectedPrimaryModel: 'opencode/fledge-alpha-free'
        })
        expect(after?.primaryAgent).toBe('reviewer')
        expect(after?.primaryModel).toBe('opencode/fledge-alpha-free')
        expect(env.OPENCODE_CONFIG_CONTENT).toContain('opencode/big-pickle')
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }, 30_000)
  }
)
