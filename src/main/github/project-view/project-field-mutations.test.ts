import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runGraphqlMock } = vi.hoisted(() => ({ runGraphqlMock: vi.fn() }))

vi.mock('./internals', () => ({
  projectGhExecOptions: (host?: string) => ({ host: host ?? 'github.com' }),
  runGraphql: runGraphqlMock
}))

import { updateProjectItemFieldValue } from './project-field-mutations'

describe('project field mutations', () => {
  beforeEach(() => {
    runGraphqlMock.mockReset().mockResolvedValue({ ok: true, data: {} })
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
})
