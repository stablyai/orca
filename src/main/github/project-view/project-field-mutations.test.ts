import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runGraphqlMock } = vi.hoisted(() => ({ runGraphqlMock: vi.fn() }))

vi.mock('./internals', () => ({
  projectGhExecOptions: (host?: string) => ({ host: host ?? 'github.com' }),
  runGraphql: runGraphqlMock
}))

import { clearProjectItemFieldValue, updateProjectItemFieldValue } from './project-field-mutations'

describe('project field mutations', () => {
  beforeEach(() => {
    runGraphqlMock.mockReset().mockResolvedValue({ ok: true, data: {} })
  })

  it('maps each field value kind to a host-pinned GraphQL variable', async () => {
    await updateProjectItemFieldValue({
      projectId: 'PVT_1',
      itemId: 'PVTI_1',
      fieldId: 'PVTF_1',
      value: { kind: 'number', number: 12.5 },
      host: 'github.corp.example'
    })

    expect(runGraphqlMock).toHaveBeenCalledWith(
      expect.stringContaining('$value:Float!'),
      { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'PVTF_1', value: 12.5 },
      { host: 'github.corp.example' }
    )
  })

  it('rejects malformed field kinds without dispatching GraphQL', async () => {
    const result = await updateProjectItemFieldValue({
      projectId: 'PVT_1',
      itemId: 'PVTI_1',
      fieldId: 'PVTF_1',
      value: { kind: 'future-kind' } as never
    })

    expect(result).toMatchObject({ ok: false, error: { type: 'validation_error' } })
    expect(runGraphqlMock).not.toHaveBeenCalled()
  })

  it('keeps clear mutations host-scoped', async () => {
    await clearProjectItemFieldValue({
      projectId: 'PVT_1',
      itemId: 'PVTI_1',
      fieldId: 'PVTF_1',
      host: 'github.corp.example'
    })

    expect(runGraphqlMock).toHaveBeenCalledWith(
      expect.stringContaining('clearProjectV2ItemFieldValue'),
      { projectId: 'PVT_1', itemId: 'PVTI_1', fieldId: 'PVTF_1' },
      { host: 'github.corp.example' }
    )
  })
})
