import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveAutomationExecutionTargetForCreate } from '../../shared/automation-execution-target'
import {
  assertAutomationDestination,
  assertExecutionTargetMatchesDestination
} from '../../shared/automation-owner-precondition'
import { RuntimeClientError } from '../runtime/types'
import { AUTOMATION_HANDLERS } from './automations'

// The CLI's saved servers, and the one managed server it may write to.
const servers = vi.hoisted(() => {
  const state: {
    environments: { id: string; orcadDeployment?: { sshTargetId: string } }[]
    repoIds: string[]
    writes: { environmentId: string; params: unknown }[]
  } = { environments: [], repoIds: [], writes: [] }
  return state
})
vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', async (original) => ({
  ...(await original<object>()),
  listEnvironments: () => servers.environments
}))
vi.mock('../runtime-client', async (original) => ({
  ...(await original<object>()),
  RuntimeClient: class {
    constructor(
      _userDataPath: string,
      _timeoutMs: number | undefined,
      _pairingCode: null,
      readonly environmentId: string
    ) {}
    async call(method: string, params?: unknown): Promise<unknown> {
      if (method === 'repo.list') {
        return ok({ repos: servers.repoIds.map((id) => ({ id })) })
      }
      servers.writes.push({ environmentId: this.environmentId, params })
      return ok({ automation: { id: 'on-server' } })
    }
  }
}))

type SshRegistration = { id: string; label: string; generation?: number }

function ok(result: unknown): unknown {
  return { id: 'request-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

/** Exercise the real destination assertions at write time, only when the client supplies a fence. */
function authority(options: {
  registered: SshRegistration[]
  /** Generation the same target carries by the time the write lands. */
  generationAtWrite?: number
  repoConnectionId?: string | null
  targetSummaryError?: Error
  /** Older hosts expose only ssh.listTargets. */
  legacyHost?: boolean
}): { call: ReturnType<typeof vi.fn>; writes: { method: string; params: unknown }[] } {
  const writes: { method: string; params: unknown }[] = []
  const connectionId = options.repoConnectionId ?? null
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'automation.show') {
      return ok({
        automation: { id: 'a1' },
        owner: { selector: { kind: 'ssh', targetId: 'box-0', targetGeneration: 3 } }
      })
    }
    if (method === 'repo.show') {
      return ok({ repo: { id: 'r1', connectionId } })
    }
    if (method === 'ssh.listTargets' && options.legacyHost) {
      return ok({ targets: options.registered })
    }
    if (method === 'ssh.listTargetSummaries') {
      if (options.legacyHost) {
        throw new RuntimeClientError('method_not_found', 'Unknown method: ssh.listTargetSummaries')
      }
      if (options.targetSummaryError) {
        throw options.targetSummaryError
      }
      return ok({ targets: options.registered })
    }
    if (method === 'automation.create' || method === 'automation.update') {
      writes.push({ method, params: params ?? {} })
      const destination = (params as { destination?: never } | undefined)?.destination
      if (destination) {
        const sshTargetGeneration = (): number | undefined => options.generationAtWrite
        assertAutomationDestination(destination, { sshTargetGeneration })
        assertExecutionTargetMatchesDestination(
          deriveAutomationExecutionTargetForCreate({
            repo: { connectionId },
            sshTargetGeneration: options.generationAtWrite
          }),
          destination
        )
      }
      return ok({ automation: { id: 'a1' } })
    }
    return ok({})
  })
  return { call, writes }
}

const CREATE_FLAGS: [string, string][] = [
  ['name', 'nightly'],
  ['prompt', 'go'],
  ['provider', 'claude'],
  ['trigger', 'daily']
]

afterEach(() => {
  vi.restoreAllMocks()
  servers.environments = []
  servers.repoIds = []
  servers.writes = []
})

// Source-owner checks cannot protect a destination removed or re-registered before the write.
describe('CLI automation writes fence the host they land on', () => {
  it('refuses a selector-moving edit onto an SSH host the authority no longer registers', async () => {
    const { call, writes } = authority({ registered: [], repoConnectionId: 'box-1' })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(
      AUTOMATION_HANDLERS['automations edit']!({
        client: { call } as never,
        cwd: '/tmp',
        flags: new Map([
          ['id', 'a1'],
          ['repo', 'repo-on-box-1']
        ]),
        json: true
      })
    ).rejects.toThrow('automation_destination_invalid')

    expect(writes).toEqual([])
  })

  it('refuses a create onto an SSH host the authority no longer registers', async () => {
    const { call, writes } = authority({ registered: [], repoConnectionId: 'box-1' })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(
      AUTOMATION_HANDLERS['automations create']!({
        client: { call } as never,
        cwd: '/tmp',
        flags: new Map([...CREATE_FLAGS, ['repo', 'repo-on-box-1']]),
        json: true
      })
    ).rejects.toThrow('automation_destination_invalid')

    expect(writes).toEqual([])
  })

  it('does not drop the fence when reading SSH registrations fails', async () => {
    const { call, writes } = authority({
      registered: [],
      repoConnectionId: 'box-1',
      targetSummaryError: new Error('rpc timeout')
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(
      AUTOMATION_HANDLERS['automations create']!({
        client: { call } as never,
        cwd: '/tmp',
        flags: new Map([...CREATE_FLAGS, ['repo', 'repo-on-box-1']]),
        json: true
      })
    ).rejects.toThrow('rpc timeout')

    expect(writes).toEqual([])
  })

  it('refuses a selector-moving edit when the host is re-registered between capture and write', async () => {
    const { call } = authority({
      registered: [{ id: 'box-1', label: 'box 1', generation: 7 }],
      generationAtWrite: 8,
      repoConnectionId: 'box-1'
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(
      AUTOMATION_HANDLERS['automations edit']!({
        client: { call } as never,
        cwd: '/tmp',
        flags: new Map([
          ['id', 'a1'],
          ['repo', 'repo-on-box-1']
        ]),
        json: true
      })
    ).rejects.toThrow('automation_destination_invalid')
  })

  it('lets a move onto a still-registered host through, carrying the incarnation it captured', async () => {
    const { call, writes } = authority({
      registered: [{ id: 'box-1', label: 'box 1', generation: 7 }],
      generationAtWrite: 7,
      repoConnectionId: 'box-1'
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await AUTOMATION_HANDLERS['automations edit']!({
      client: { call } as never,
      cwd: '/tmp',
      flags: new Map([
        ['id', 'a1'],
        ['repo', 'repo-on-box-1']
      ]),
      json: true
    })

    expect(writes[0]?.params).toMatchObject({
      destination: { selector: { kind: 'ssh', targetId: 'box-1', targetGeneration: 7 } }
    })
  })

  it('fences a create on an older host that only answers the legacy SSH listing', async () => {
    const { call, writes } = authority({
      registered: [{ id: 'box-1', label: 'box 1', generation: 7 }],
      generationAtWrite: 7,
      repoConnectionId: 'box-1',
      legacyHost: true
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await AUTOMATION_HANDLERS['automations create']!({
      client: { call } as never,
      cwd: '/tmp',
      flags: new Map([...CREATE_FLAGS, ['repo', 'repo-on-box-1']]),
      json: true
    })

    expect(call).toHaveBeenCalledWith('ssh.listTargets')
    expect(writes[0]?.params).toMatchObject({
      destination: { selector: { kind: 'ssh', targetId: 'box-1', targetGeneration: 7 } }
    })
  })

  // Older hosts cannot provide generations; omit the fence to preserve compatibility.
  it('omits the destination when the authority registers the target without a generation', async () => {
    const { call, writes } = authority({
      registered: [{ id: 'box-1', label: 'box 1' }],
      repoConnectionId: 'box-1'
    })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await AUTOMATION_HANDLERS['automations edit']!({
      client: { call } as never,
      cwd: '/tmp',
      flags: new Map([
        ['id', 'a1'],
        ['repo', 'repo-on-box-1']
      ]),
      json: true
    })

    expect(writes[0]?.params).not.toHaveProperty('destination')
  })

  it('sends a self destination for a local project', async () => {
    const { call, writes } = authority({ registered: [], repoConnectionId: null })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await AUTOMATION_HANDLERS['automations create']!({
      client: { call } as never,
      cwd: '/tmp',
      flags: new Map([...CREATE_FLAGS, ['repo', 'local-repo']]),
      json: true
    })

    expect(writes[0]?.params).toMatchObject({ destination: { selector: { kind: 'self' } } })
  })

  it('sends no destination when the edit names no project or workspace', async () => {
    const { call, writes } = authority({ registered: [] })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await AUTOMATION_HANDLERS['automations edit']!({
      client: { call } as never,
      cwd: '/tmp',
      flags: new Map([
        ['id', 'a1'],
        ['name', 'renamed']
      ]),
      json: true
    })

    expect(call).not.toHaveBeenCalledWith('repo.show', expect.anything())
    expect(writes[0]?.params).not.toHaveProperty('destination')
  })
})

// Desktop copies on a managed SSH host never run; its server holds them (#24863).
describe('CLI automation creates for a managed SSH host', () => {
  const managedHost = () => {
    servers.environments = [{ id: 'env-1', orcadDeployment: { sshTargetId: 'box-1' } }]
    return authority({
      registered: [{ id: 'box-1', label: 'box 1', generation: 7 }],
      repoConnectionId: 'box-1'
    })
  }

  it("creates on the host's Orca server by project id", async () => {
    const { call, writes } = managedHost()
    servers.repoIds = ['r1']
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await AUTOMATION_HANDLERS['automations create']!({
      client: { call } as never,
      cwd: '/tmp',
      flags: new Map([...CREATE_FLAGS, ['repo', 'repo-on-box-1']]),
      json: true
    })

    expect(writes).toEqual([])
    expect(servers.writes).toEqual([
      { environmentId: 'env-1', params: expect.objectContaining({ repo: 'id:r1' }) }
    ])
    expect(servers.writes[0]?.params).not.toHaveProperty('destination')
  })

  it('asks to move a project the server does not have', async () => {
    const { call } = managedHost()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(
      AUTOMATION_HANDLERS['automations create']!({
        client: { call } as never,
        cwd: '/tmp',
        flags: new Map([...CREATE_FLAGS, ['repo', 'repo-on-box-1']]),
        json: true
      })
    ).rejects.toThrow('Move this project to box 1 first.')
    expect(servers.writes).toEqual([])
  })
})
