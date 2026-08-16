import { describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'
import { TaskResumeState } from './task-resume-state-schema'

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'ui.set', params }
}

function makeDispatcher(): { dispatcher: RpcDispatcher; updateUIState: ReturnType<typeof vi.fn> } {
  const updateUIState = vi.fn(() => getDefaultUIState())
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    updateUIState
  } as unknown as OrcaRuntimeService
  return { dispatcher: new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS }), updateUIState }
}

describe('ui.set task resume state', () => {
  it('persists the cross-client resume fields', async () => {
    const { dispatcher, updateUIState } = makeDispatcher()
    const taskResumeState = {
      githubMode: 'items' as const,
      githubItemsQuery: 'is:open',
      linearMode: 'issues' as const,
      linearQuery: 'label:bug',
      jiraPreset: 'reported' as const
    }

    const response = await dispatcher.dispatch(makeRequest({ taskResumeState }))

    expect(response).toMatchObject({ ok: true })
    expect(updateUIState).toHaveBeenCalledWith({ taskResumeState })
  })

  // Why: this object is `.strict()` behind ui.set's field-level `.catch`, so ONE key a
  // host predates silently discards the whole resume state — github and jira with it —
  // and still reports success. That is why per-device view preferences stay client-local.
  it('drops the whole resume state when a payload carries a key the schema omits', async () => {
    const { dispatcher, updateUIState } = makeDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest({
        sidebarWidth: 280,
        taskResumeState: { linearQuery: 'label:bug', somethingThisHostPredates: true }
      })
    )

    expect(response).toMatchObject({ ok: true })
    expect(updateUIState).toHaveBeenCalledWith({ sidebarWidth: 280 })
  })

  // Why: #12710 shipped this key and every host older than it drops the whole resume
  // state on receipt. It is device-local storage now; putting it back re-breaks pairing.
  it('keeps the Linear issue view off the wire', () => {
    expect(Object.keys(TaskResumeState.shape)).not.toContain('linearIssueView')
  })
})
