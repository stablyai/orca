import { describe, expect, it } from 'vitest'
import {
  mapCheckConclusion,
  mapCheckRunRESTConclusion,
  mapCheckRunRESTStatus,
  mapCheckStatus
} from './mappers'
import { summarizeProviderChecks } from '../../shared/provider-check-summary'

describe('check status mappers', () => {
  it('keeps waiting/requested check runs non-terminal', () => {
    expect(mapCheckRunRESTStatus('waiting')).toBe('queued')
    expect(mapCheckRunRESTStatus('requested')).toBe('queued')
    expect(mapCheckRunRESTStatus('pending')).toBe('queued')
    expect(mapCheckRunRESTConclusion('waiting', null)).toBe('pending')
    expect(mapCheckRunRESTConclusion('requested', null)).toBe('pending')
  })

  it('maps gh pr checks Waiting/Requested to pending, not failure', () => {
    expect(mapCheckStatus('WAITING')).toBe('queued')
    expect(mapCheckStatus('REQUESTED')).toBe('queued')
    expect(mapCheckConclusion('WAITING')).toBe('pending')
    expect(mapCheckConclusion('REQUESTED')).toBe('pending')
    expect(
      summarizeProviderChecks([
        { status: mapCheckStatus('WAITING'), conclusion: mapCheckConclusion('WAITING') },
        { status: mapCheckStatus('REQUESTED'), conclusion: mapCheckConclusion('REQUESTED') }
      ])
    ).toMatchObject({ state: 'pending', failed: 0, pending: 2 })
    expect(mapCheckConclusion('FAILURE')).toBe('failure')
    expect(mapCheckConclusion('ACTION_REQUIRED')).toBe('action_required')
  })
})
