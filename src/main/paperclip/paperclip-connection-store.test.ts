import { describe, expect, it } from 'vitest'
import { createPaperclipConnectionId } from './paperclip-connection-id'
import { normalizePaperclipConnection } from './paperclip-connection-store'

describe('Paperclip persisted connection boundary', () => {
  const origin = 'http://127.0.0.1:3100'
  const companyId = 'company-1'
  const projectId = 'project-1'
  const id = createPaperclipConnectionId(origin, companyId, projectId)

  it('reconstructs only canonical identity fields', () => {
    expect(
      normalizePaperclipConnection({
        id,
        origin,
        companyId,
        projectId,
        companyName: 'mutable label',
        projectName: 'mutable label',
        token: 'must-not-cross'
      })
    ).toEqual({ id, origin, companyId, projectId })
  })

  it('fails closed when origin and derived identity disagree', () => {
    expect(
      normalizePaperclipConnection({
        id,
        origin: 'http://127.0.0.2:3100',
        companyId,
        projectId
      })
    ).toBeNull()
  })
})
