import { describe, expect, it } from 'vitest'
import { rpcRefusal, rpcSuccess } from '../transport/rpc-operation-test-families'
import { requireAcceptedSessionTabProps } from './session-tab-set-props-bridge'

describe('session tab props mobile bridge', () => {
  it('rejects an RPC refusal instead of fulfilling with undefined', () => {
    expect(() => requireAcceptedSessionTabProps(rpcRefusal('refused'))).toThrow(
      'session.tabs.setTabProps was not accepted'
    )
  })

  it('preserves the accepted publication marker for pending-write settlement', () => {
    expect(
      requireAcceptedSessionTabProps(
        rpcSuccess({ updated: true, publicationEpoch: 'epoch-1', snapshotVersion: 7 })
      )
    ).toEqual({ updated: true, publicationEpoch: 'epoch-1', snapshotVersion: 7 })
  })
})
