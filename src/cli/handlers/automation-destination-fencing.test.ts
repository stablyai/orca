import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveAutomationExecutionTargetForCreate } from '../../shared/automation-execution-target'
import {
  assertAutomationDestination,
  assertExecutionTargetMatchesDestination
} from '../../shared/automation-owner-precondition'
import { AUTOMATION_HANDLERS } from './automations'

type SshRegistration = { id: string; label: string; generation?: number }

function ok(result: unknown): unknown {
  return { id: 'request-1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

/**
 * Stands in for the storing authority: it answers the reads the CLI makes and
 * enforces the destination exactly where persistence does — with the real
 * assertions, and only when the client actually supplies one.
 */
function authority(options: {
  /** What `ssh.listTargetSummaries` reports while the CLI captures its destination. */
  registered: SshRegistration[]
  /** Generation the same target carries by the time the write lands. */
  generationAtWrite?: number
  repoConnectionId?: string | null
  targetSummaryError?: Error
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
    if (method === 'ssh.listTargetSummaries') {
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

afterEach(() => vi.restoreAllMocks())

// The expected owner only fences the host the record is leaving. Without the
// destination the arrival is never checked, so a move onto a host that is gone —
// or gone and re-registered as a different machine under the same id — is
// accepted and only surfaces later, at dispatch, as a dead automation.
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

  // A host that predates SSH generations has no incarnation to capture, so the
  // write must still land — failing closed there would break a host that is only old.
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

  // Nothing moves, so there is no arrival to fence and no reason to spend the reads.
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
