import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { resolveClaudeChildEnvSources } from '../claude/claude-structured-child-env'
import {
  createAcpStructuredLaunchResolver,
  createCodexStructuredLaunchResolver
} from './structured-agent-launch-composition.test-support'

const GROK = acpLaunchSpecFor('grok')!
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'grok',
  providerHandle: null
}
const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

/**
 * A host whose shell env was read before an agent was installed into a folder only the profile
 * puts on PATH, as in the live check over SSH; only a reread sees it. `name` is unique so nothing
 * on the machine running the test can answer for it.
 */
function hostInstallingAfterFirstCapture(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'orca-install-after-capture-'))
  roots.push(root)
  const profileBin = join(root, 'profile-bin')
  mkdirSync(profileBin)
  const program = join(profileBin, process.platform === 'win32' ? `${name}.cmd` : name)
  writeFileSync(program, '#!/bin/sh\nexit 0\n')
  chmodSync(program, 0o755)
  let served = '/usr/bin'
  const environment = {
    resolveBaseEnvironment: async () => ({ PATH: served, HOME: root }),
    refreshAfterMissingProgram: vi.fn(async (_askedAt: number) => {
      served = profileBin
    })
  }
  return { environment, program, profileBin }
}

function store(record: Partial<AgentSessionRecord>) {
  return {
    getRecord: () => ({ ...agentSessionRecordFixture(), providerHandleChain: [], ...record }),
    pinLaunchDirectory: vi.fn()
  }
}

describe('an agent installed after the first shell capture', () => {
  it("starts Claude's first chat, from the refreshed environment", async () => {
    const name = `claude-l5-${process.pid}`
    const host = hostInstallingAfterFirstCapture(name)
    const sources = await resolveClaudeChildEnvSources({
      resolveInheritedEnv: host.environment.resolveBaseEnvironment,
      refreshEnvironmentAfterMiss: host.environment.refreshAfterMissingProgram,
      resolveCommand: (options) => resolveCliCommand(name, options)
    })
    expect(sources.command).toBe(host.program)
    expect(sources.inheritedEnv.PATH).toBe(host.profileBin)
  })

  it("starts Codex's first chat through the composed launch, from the refreshed environment", async () => {
    const name = `codex-l5-${process.pid}`
    const host = hostInstallingAfterFirstCapture(name)
    const launch = await createCodexStructuredLaunchResolver({
      store: store({
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: join(host.profileBin, '..', '.codex') }
      }),
      resolveEnvironment: host.environment.resolveBaseEnvironment,
      refreshAfterMissingProgram: host.environment.refreshAfterMissingProgram,
      resolveCommand: (options) => resolveCliCommand(name, options),
      resolveLaunchArgs: () => []
    })({ identity: { ...identity, agent: 'codex' } })
    expect(launch.command).toBe(host.program)
    expect(launch.env.PATH).toBe(host.profileBin)
  })

  it('starts a Command setting installed after the capture, rather than refusing it', async () => {
    const name = `grok-l5-${process.pid}`
    const host = hostInstallingAfterFirstCapture(name)
    const launch = await createAcpStructuredLaunchResolver(GROK, {
      store: store({
        provider: 'grok',
        accountHome: { variable: 'GROK_HOME', path: join(host.profileBin, '..', '.grok') }
      }),
      readJournal: () => null,
      resolveEnvironment: host.environment.resolveBaseEnvironment,
      refreshAfterMissingProgram: host.environment.refreshAfterMissingProgram,
      resolveCommandSettings: () => ({ agentCmdOverrides: { grok: name } })
    })({ identity })
    expect(launch.command).toBe(host.program)
  })

  it('never refreshes for a program the snapshot already finds', async () => {
    const name = `codex-l5-found-${process.pid}`
    const host = hostInstallingAfterFirstCapture(name)
    // Puts the install in the snapshot before the launch asks.
    await host.environment.refreshAfterMissingProgram(Date.now())
    const refresh = vi.fn(async () => {})
    const launch = await createCodexStructuredLaunchResolver({
      store: store({
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: join(host.profileBin, '..', '.codex') }
      }),
      resolveEnvironment: host.environment.resolveBaseEnvironment,
      refreshAfterMissingProgram: refresh,
      resolveCommand: (options) => resolveCliCommand(name, options),
      resolveLaunchArgs: () => []
    })({ identity: { ...identity, agent: 'codex' } })
    expect(launch.command).toBe(host.program)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('rereads only when no PATH entry has the program, a relative one searched from the chat', async () => {
    // A workspace `bin` on PATH: the spawn finds the program in the chat's directory, where the
    // lookup did not search, so its bare name is not a miss; an entry without it still is.
    const name = `codex-relative-${process.pid}`
    const workspace = mkdtempSync(join(tmpdir(), 'orca-relative-path-'))
    roots.push(workspace)
    mkdirSync(join(workspace, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(workspace, 'node_modules', '.bin', name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(workspace, 'node_modules', '.bin', name), 0o755)
    const launchFrom = async (PATH: string) => {
      const refresh = vi.fn(async (_askedAt: number) => {})
      const launch = await createCodexStructuredLaunchResolver({
        store: store({
          provider: 'codex',
          accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' }
        }),
        resolveWorkspacePath: async () => workspace,
        resolveEnvironment: async () => ({ PATH, HOME: '/home/user' }),
        refreshAfterMissingProgram: refresh,
        resolveCommand: (options) => resolveCliCommand(name, options),
        resolveLaunchArgs: () => []
      })({ identity: { ...identity, agent: 'codex' } })
      return { command: launch.command, rereads: refresh.mock.calls.length }
    }
    expect(await launchFrom(['/usr/bin', join('node_modules', '.bin')].join(delimiter))).toEqual({
      command: name,
      rereads: 0
    })
    expect(await launchFrom(['/usr/bin', 'bin'].join(delimiter))).toEqual({
      command: name,
      rereads: 1
    })
    expect(await launchFrom('/usr/bin')).toEqual({ command: name, rereads: 1 })
  })
})
