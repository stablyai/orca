import { describe, expect, it, vi } from 'vitest'
import {
  ambiguousEnvironments,
  ambiguousSshTargets,
  crossKindNextSteps,
  findEnvironmentByName,
  findSshTargetByName,
  listSshTargets,
  resolveSshHostTargetId
} from './host-selector-alternatives'
import type { RuntimeClient } from './runtime-client'

const SSH_TARGETS = [{ id: 'ssh-1755000000000-a1b2c3', label: 'openclaw' }]
const ENVIRONMENTS = [{ id: '03ef704c-b180-4b10-998d-e28fbd5de9a3', name: 'awin' }]

function clientReturning(targets: { id: string; label: string }[]): RuntimeClient {
  return {
    call: vi.fn(async () => ({ result: { targets } }))
  } as unknown as RuntimeClient
}

describe('findSshTargetByName', () => {
  // Why: ids are machine-generated `ssh-<timestamp>-<random>`, so the label is the only name a
  // person or agent ever has. Matching ids alone reports "not found" for a target that exists.
  it('matches the human label as well as the generated id', () => {
    expect(findSshTargetByName(SSH_TARGETS, 'openclaw')?.id).toBe('ssh-1755000000000-a1b2c3')
    expect(findSshTargetByName(SSH_TARGETS, 'ssh-1755000000000-a1b2c3')?.label).toBe('openclaw')
    expect(findSshTargetByName(SSH_TARGETS, 'OpenClaw')?.label).toBe('openclaw')
  })

  it('does not invent a match', () => {
    expect(findSshTargetByName(SSH_TARGETS, 'awin')).toBeUndefined()
  })
})

describe('findEnvironmentByName', () => {
  it('matches a paired server by name or id', () => {
    expect(findEnvironmentByName(ENVIRONMENTS, 'awin')?.id).toBe(ENVIRONMENTS[0]!.id)
    expect(findEnvironmentByName(ENVIRONMENTS, ENVIRONMENTS[0]!.id)?.name).toBe('awin')
  })
})

describe('crossKindNextSteps', () => {
  const alternatives = { sshTargets: SSH_TARGETS, environments: ENVIRONMENTS }

  it('points an SSH name at the SSH flag when a server was asked for', () => {
    const steps = crossKindNextSteps('openclaw', alternatives, 'environment')

    expect(steps.join('\n')).toContain('--host ssh:ssh-1755000000000-a1b2c3')
    expect(steps.join('\n')).toContain('is an SSH target')
  })

  it('points a server name at --environment when an SSH target was asked for', () => {
    const steps = crossKindNextSteps('awin', alternatives, 'ssh')

    expect(steps.join('\n')).toContain('--environment awin')
    expect(steps.join('\n')).toContain('is a paired Orca server')
  })

  it('says nothing when the name exists on neither axis', () => {
    expect(crossKindNextSteps('nowhere', alternatives, 'ssh')).toEqual([])
  })

  // Why: suggesting the axis the caller already used would be noise, not help.
  it('does not suggest the axis that was already requested', () => {
    expect(crossKindNextSteps('openclaw', alternatives, 'ssh')).toEqual([])
    expect(crossKindNextSteps('awin', alternatives, 'environment')).toEqual([])
  })
})

describe('resolveSshHostTargetId', () => {
  it('resolves a label to the target id', async () => {
    await expect(
      resolveSshHostTargetId(clientReturning(SSH_TARGETS), 'openclaw', ENVIRONMENTS)
    ).resolves.toBe('ssh-1755000000000-a1b2c3')
  })

  // Why: this used to answer ok:true with an empty list — the same silent wrong-machine result
  // that unknown runtime ids gave before they were rejected.
  it('rejects an unknown target instead of letting it filter to nothing', async () => {
    await expect(
      resolveSshHostTargetId(clientReturning(SSH_TARGETS), 'nowhere', ENVIRONMENTS)
    ).rejects.toThrow('no SSH target named or with id nowhere')
  })

  it('names the paired server when an SSH target was asked for by a server name', async () => {
    await expect(
      resolveSshHostTargetId(clientReturning(SSH_TARGETS), 'awin', ENVIRONMENTS)
    ).rejects.toMatchObject({
      data: {
        nextSteps: expect.arrayContaining([expect.stringContaining('--environment awin')])
      }
    })
  })

  it('says so plainly when the host has no SSH targets at all', async () => {
    await expect(
      resolveSshHostTargetId(clientReturning([]), 'openclaw', ENVIRONMENTS)
    ).rejects.toMatchObject({
      data: { nextSteps: expect.arrayContaining(['This Orca host has no SSH targets registered.']) }
    })
  })
})

describe('listSshTargets', () => {
  // Why: an older host answers listTargets but not listTargetSummaries. Treating that as "no
  // targets" would reject an ssh id that is valid on that host.
  it('falls back to the older listing when the newer method is absent', async () => {
    const { RuntimeClientError } = await import('./runtime/types.js')
    const call = vi.fn(async (method: string) => {
      if (method === 'ssh.listTargetSummaries') {
        throw new RuntimeClientError('method_not_found', 'Unknown method')
      }
      return { result: { targets: SSH_TARGETS } }
    })

    await expect(listSshTargets({ call } as unknown as RuntimeClient)).resolves.toEqual(SSH_TARGETS)
    expect(call).toHaveBeenCalledWith('ssh.listTargets')
  })

  // Why: this only ever runs to enrich an error we are already reporting; a failure here must
  // not replace that error with a confusing one about SSH enumeration.
  it('returns nothing rather than masking the error it was enriching', async () => {
    const client = {
      call: vi.fn(async () => {
        throw new Error('boom')
      })
    }

    await expect(listSshTargets(client as unknown as RuntimeClient)).resolves.toEqual([])
  })
})

describe('ambiguous names never resolve silently', () => {
  const twoOpenclaw = [
    { id: 'ssh-1-a', label: 'openclaw' },
    { id: 'ssh-2-b', label: 'openclaw' }
  ]
  const twoAwin = [
    { id: 'env-1', name: 'awin' },
    { id: 'env-2', name: 'awin' }
  ]

  // Why: picking the first would choose a machine on the caller's behalf — the exact failure the
  // whole selector path exists to prevent.
  it('refuses to guess between two ssh targets sharing a label', () => {
    expect(findSshTargetByName(twoOpenclaw, 'openclaw')).toBeUndefined()
    expect(ambiguousSshTargets(twoOpenclaw, 'openclaw')).toHaveLength(2)
  })

  it('refuses to guess between two servers sharing a name', () => {
    expect(findEnvironmentByName(twoAwin, 'awin')).toBeUndefined()
    expect(ambiguousEnvironments(twoAwin, 'awin')).toHaveLength(2)
  })

  // An exact id is never ambiguous, even when labels collide.
  it('still resolves an exact id past a colliding label', () => {
    expect(findSshTargetByName(twoOpenclaw, 'ssh-2-b')?.id).toBe('ssh-2-b')
    expect(findEnvironmentByName(twoAwin, 'env-2')?.id).toBe('env-2')
  })

  it('reports no ambiguity for a unique name', () => {
    expect(ambiguousSshTargets(SSH_TARGETS, 'openclaw')).toEqual([])
    expect(ambiguousEnvironments(ENVIRONMENTS, 'awin')).toEqual([])
  })

  it('names both candidates when an ssh label is ambiguous', async () => {
    await expect(
      resolveSshHostTargetId(clientReturning(twoOpenclaw), 'openclaw', ENVIRONMENTS)
    ).rejects.toMatchObject({
      data: {
        nextSteps: expect.arrayContaining([
          expect.stringContaining('ssh-1-a'),
          expect.stringContaining('ssh-2-b')
        ])
      }
    })
  })
})
