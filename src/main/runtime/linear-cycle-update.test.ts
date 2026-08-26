import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinearCycleSummary } from '../../shared/linear/cycle-types'
import * as linearClient from '../linear/client'
import * as linearCycles from '../linear/cycles'
import * as linearIssues from '../linear/issues'
import type { LinearIssueWriteRecord } from '../linear/issues'
import { OrcaRuntimeService } from './orca-runtime'

const issue: LinearIssueWriteRecord = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Issue',
  url: 'https://linear.app/acme/issue/ENG-1',
  team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
  state: { id: 'state-1', name: 'Todo' },
  parent: null,
  cycle: null,
  labels: []
}

const currentCycle: LinearCycleSummary = {
  id: 'cycle-7',
  number: 7,
  name: null,
  description: null,
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-08-14T00:00:00.000Z',
  isActive: true,
  isFuture: false,
  isPast: false
}

type CycleUpdateInternals = {
  buildLinearTaskUpdate(
    params: { operation: 'cycle'; cycleInput: string | null },
    current: LinearIssueWriteRecord,
    workspaceId: string
  ): Promise<{ fields: { cycleId?: string | null } }>
}

afterEach(() => vi.restoreAllMocks())

describe('Linear runtime cycle updates', () => {
  it('resolves current against the target issue team and workspace', async () => {
    const entry = { workspace: { id: 'workspace-1' } }
    vi.spyOn(linearClient, 'getClients').mockReturnValue([entry] as never)
    const listCycles = vi
      .spyOn(linearCycles, 'listTeamCyclesForAgent')
      .mockResolvedValue([currentCycle])
    const runtime = new OrcaRuntimeService() as unknown as CycleUpdateInternals

    await expect(
      runtime.buildLinearTaskUpdate(
        { operation: 'cycle', cycleInput: 'current' },
        issue,
        'workspace-1'
      )
    ).resolves.toEqual({ fields: { cycleId: 'cycle-7' } })
    expect(linearClient.getClients).toHaveBeenCalledWith('workspace-1')
    expect(listCycles).toHaveBeenCalledWith(entry, 'team-1', true)
  })

  it.each([[[]], [[currentCycle, { ...currentCycle, id: 'cycle-8', number: 8 }]]])(
    'rejects a non-unique current cycle before a write for %j',
    async (cycles) => {
      vi.spyOn(linearClient, 'getClients').mockReturnValue([{}] as never)
      vi.spyOn(linearCycles, 'listTeamCyclesForAgent').mockResolvedValue(cycles)
      const update = vi.spyOn(linearIssues, 'updateIssueForAgent')
      const runtime = new OrcaRuntimeService() as unknown as CycleUpdateInternals

      await expect(
        runtime.buildLinearTaskUpdate(
          { operation: 'cycle', cycleInput: 'current' },
          issue,
          'workspace-1'
        )
      ).rejects.toMatchObject({ code: 'linear_invalid_cycle' })
      expect(update).not.toHaveBeenCalled()
    }
  )

  it('passes null through the runtime write and reports the cleared cycle', async () => {
    const update = vi.spyOn(linearIssues, 'updateIssueForAgent').mockResolvedValue({
      ...issue,
      cycle: null
    })
    const runtime = runtimeForWrite([
      { ...issue, cycle: { id: 'cycle-7', name: null } },
      { ...issue, cycle: null }
    ])

    await expect(
      runtime.linearIssueUpdateTask({
        input: issue.identifier,
        operation: 'cycle',
        cycleInput: null
      })
    ).resolves.toMatchObject({ current: { cycle: null } })
    expect(update).toHaveBeenCalledWith(
      'issue-1',
      { cycleId: null },
      'workspace-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('does not write when the cycle is already clear', async () => {
    const update = vi.spyOn(linearIssues, 'updateIssueForAgent')
    const runtime = runtimeForWrite([issue])

    await expect(
      runtime.linearIssueUpdateTask({
        input: issue.identifier,
        operation: 'cycle',
        cycleInput: null
      })
    ).resolves.toMatchObject({ meta: { alreadySet: true }, current: { cycle: null } })
    expect(update).not.toHaveBeenCalled()
  })

  it('returns unconfirmed when the assigned cycle does not persist', async () => {
    vi.spyOn(linearIssues, 'updateIssueForAgent').mockResolvedValue({
      ...issue,
      cycle: { id: 'cycle-other', name: 'Other' }
    })
    const runtime = runtimeForWrite([issue])
    Object.assign(runtime, {
      buildLinearTaskUpdate: vi.fn().mockResolvedValue({ fields: { cycleId: 'cycle-7' } })
    })

    await expect(
      runtime.linearIssueUpdateTask({
        input: issue.identifier,
        operation: 'cycle',
        cycleInput: 'current'
      })
    ).rejects.toMatchObject({ code: 'linear_write_unconfirmed' })
  })
})

function runtimeForWrite(records: LinearIssueWriteRecord[]): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  Object.assign(runtime, {
    resolveLinearAgentWriteTarget: vi.fn().mockResolvedValue({ issue, workspaceId: 'workspace-1' }),
    readLinearAgentIssueWriteRecord: vi.fn().mockImplementation(() => records.shift() ?? issue),
    notifyLinearLinkedIssueUpdated: vi.fn().mockResolvedValue(undefined)
  })
  return runtime
}
