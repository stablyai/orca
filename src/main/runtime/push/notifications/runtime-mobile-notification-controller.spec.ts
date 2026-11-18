import { describe, expect, it } from 'vitest'
import '../../../../shared/worktree/host-qualified-identity'
import '../../construction/test-context/runtime-test-module-registration.spec'
import '../../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../../git/worktrees/catalog/worktree-scan-cache'

import '../../session-lifecycle/close/mobile-session-tab-close-outcome'
import {
  TEST_WORKTREE_ID,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('isolates a throwing subscriber across runtime listener fan-out', () => {
    const runtime = new OrcaRuntimeService(store)
    const delivered: number[] = []
    // Sibling notification fan-outs must also isolate throwing subscribers.
    runtime.onNotificationDispatched(() => {
      throw new Error('subscriber_send_failed')
    })
    runtime.onNotificationDispatched((event) => {
      delivered.push(event.notificationSeq ?? -1)
    })

    expect(() =>
      runtime.dispatchMobileNotification({
        type: 'notification',
        source: 'test',
        title: 'Test',
        body: 'Body',
        worktreeId: TEST_WORKTREE_ID
      })
    ).not.toThrow()

    expect(delivered).toHaveLength(1)
  })
})
