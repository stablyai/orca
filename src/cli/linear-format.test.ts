import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearSearchResult } from '../shared/linear-agent-access'
import { printLinearSearchWarnings } from './linear-format'

describe('linear-format', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('treats older search results without workspaceErrors as non-partial', () => {
    const result = {
      issues: [],
      meta: {
        query: 'auth',
        workspaceId: 'all',
        limit: 20,
        returned: 0,
        limitReached: false,
        partial: false
      }
    } as unknown as LinearSearchResult

    printLinearSearchWarnings(result)

    expect(console.error).not.toHaveBeenCalled()
  })
})
