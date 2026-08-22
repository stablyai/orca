// Why (#8711): reproduced live — with an SSH host connected and its remote
// `~/.codex/hooks.json` absent, `orca agent hooks status` printed
// `codex: installed` from the local managed home, naming no host at all. These
// tests fail against that behavior: the report must name each host, and must
// never let the local answer stand in for a host it did not check.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { AgentHookHostReport } from '../../shared/agent-hook-host-status'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'

const { callMock, getCliStatusMock, getDefaultUserDataPathMock, getManagedAgentHookStatusesMock } =
  vi.hoisted(() => ({
    callMock: vi.fn(),
    getCliStatusMock: vi.fn(),
    getDefaultUserDataPathMock: vi.fn(),
    getManagedAgentHookStatusesMock: vi.fn()
  }))

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = getCliStatusMock
  }
  class RuntimeClientError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return { RuntimeClient, RuntimeClientError, getDefaultUserDataPath: getDefaultUserDataPathMock }
})

vi.mock('../../main/agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: vi.fn(),
  getManagedAgentHookStatuses: getManagedAgentHookStatusesMock,
  prepareManagedCodexHomeBeforeShellLaunch: vi.fn()
}))

import { main } from '../index'

const LOCAL_CODEX_INSTALLED: AgentHookInstallStatus = {
  agent: 'codex',
  state: 'installed',
  configPath: '/Users/dev/Library/Application Support/orca/codex-runtime-home/home/hooks.json',
  managedHooksPresent: true,
  detail: null
}

function sshHostReport(state: AgentHookHostReport['state']): AgentHookHostReport {
  return {
    host: { kind: 'ssh', targetId: 'ssh-1', label: 'my-linux-box' },
    state,
    detail: state === 'skipped' ? 'No managed agent CLI was detected on the remote host.' : null,
    statuses:
      state === 'skipped'
        ? []
        : [
            {
              agent: 'codex',
              state: 'not_installed',
              configPath: '/home/dev/.codex/hooks.json',
              managedHooksPresent: false,
              detail: null
            }
          ]
  }
}

describe('orca agent hooks status — per-host truthfulness', () => {
  let userDataPath: string
  let logged: string[]

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-hooks-host-'))
    mkdirSync(userDataPath, { recursive: true })
    writeFileSync(
      join(userDataPath, 'orca-data.json'),
      JSON.stringify(getDefaultPersistedState(userDataPath), null, 2),
      'utf-8'
    )
    getDefaultUserDataPathMock.mockReturnValue(userDataPath)
    getManagedAgentHookStatusesMock.mockReturnValue([LOCAL_CODEX_INSTALLED])
    callMock.mockReset()
    getCliStatusMock.mockReset()
    logged = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  async function runStatus(json = false): Promise<string> {
    await main(['agent', 'hooks', 'status', ...(json ? ['--json'] : [])], userDataPath)
    return logged.join('\n')
  }

  it('names the SSH host that runs the agent instead of only the local machine', async () => {
    callMock.mockResolvedValue({
      result: { hosts: [localReport(), sshHostReport('partial')] }
    })

    const output = await runStatus()

    expect(callMock).toHaveBeenCalledWith('agentHooks.status', undefined, { timeoutMs: 10_000 })
    expect(output).toContain('local: installed')
    expect(output).toContain('ssh:my-linux-box: partial')
    expect(output).toContain('codex: not_installed')
  })

  it('does not report the SSH host as installed when Codex is missing there', async () => {
    callMock.mockResolvedValue({ result: { hosts: [localReport(), sshHostReport('skipped')] } })

    const output = await runStatus()

    expect(output).toContain('ssh:my-linux-box: skipped')
    expect(output).toContain('No managed agent CLI was detected on the remote host.')
    expect(output).not.toMatch(/ssh:my-linux-box: installed/)
  })

  it('says SSH host status is unavailable when the runtime cannot be reached', async () => {
    callMock.mockRejectedValue(new Error('runtime_unreachable'))

    const output = await runStatus()

    expect(output).toContain('local: installed')
    expect(output).toContain('ssh: unknown')
    expect(output).toContain('SSH host hook status is unavailable from this machine.')
    // Why: the notice belongs to the hosts Orca could not check, not to the
    // local host — attaching it there would mislabel a healthy local install.
    expect(output).not.toMatch(/local: \w+ — Orca is not running/)
  })

  it('scopes every JSON status line to a named host', async () => {
    callMock.mockResolvedValue({ result: { hosts: [localReport(), sshHostReport('partial')] } })

    const parsed = JSON.parse(await runStatus(true)) as {
      result: { hosts: AgentHookHostReport[] }
    }

    expect(parsed.result.hosts.map((host) => host.host.kind)).toEqual(['local', 'ssh'])
    for (const host of parsed.result.hosts) {
      expect(host.host).toBeDefined()
      expect(host.state).toBeDefined()
    }
  })
})

function localReport(): AgentHookHostReport {
  return {
    host: { kind: 'local' },
    state: 'installed',
    detail: null,
    statuses: [LOCAL_CODEX_INSTALLED]
  }
}
