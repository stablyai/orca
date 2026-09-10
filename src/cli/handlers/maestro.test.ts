import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const writeMock = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { MAESTRO_HANDLERS } from './maestro'

describe('maestro CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    callMock.mockResolvedValue({ result: {} })
  })

  afterEach(() => {
    writeMock.mockClear()
  })

  function context(flags: [string, string | boolean][]) {
    return { flags: new Map(flags), client: { call: callMock }, json: true, cwd: '/repo' } as never
  }

  it('reads the exact host and workspace scope', async () => {
    await MAESTRO_HANDLERS['maestro show'](
      context([
        ['host', 'ssh:build'],
        ['workspace', 'folder:workspace_1']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('maestro.document.get', {
      scope: { execution_host_id: 'ssh:build', workspace_key: 'folder:workspace_1' }
    })
  })

  it('forwards receipt selectors without deriving workspace identity from a path', async () => {
    await MAESTRO_HANDLERS['maestro workspace-bootstrap-receipt'](
      context([
        ['run', 'run_1'],
        ['orchestration-home', 'id:folder:home_1'],
        ['execution-workspace', 'id:folder:work_1'],
        ['host', 'ssh:build']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.workspaceBootstrapReceipt', {
      runId: 'run_1',
      orchestrationHomeSelector: 'id:folder:home_1',
      executionWorkspaceSelector: 'id:folder:work_1',
      executionHostId: 'ssh:build'
    })
  })

  it('forwards browser requests without inventing observed visibility', async () => {
    const payload = {
      workspace: {
        repository_id: 'repo_1',
        execution_host_id: 'local',
        workspace_key: 'folder:workspace_1',
        run_id: 'run_1'
      },
      requested_visibility: 'visible'
    }
    await MAESTRO_HANDLERS['maestro browser-surface open'](
      context([['payload', JSON.stringify(payload)]])
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.browserSurface.ensure', payload)
  })

  it('advances its bounded watch cursor and emits compact NDJSON', async () => {
    callMock
      .mockResolvedValueOnce({
        result: { resetRequired: false, revision: 2, deltas: [{ revision: 2 }] }
      })
      .mockResolvedValueOnce({ result: { resetRequired: false, revision: 2, deltas: [] } })

    await MAESTRO_HANDLERS['maestro watch'](
      context([['payload', JSON.stringify({ workspace: {}, sinceRevision: 1 })]])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'maestro.document.deltas', {
      workspace: {},
      sinceRevision: 1
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'maestro.document.deltas', {
      workspace: {},
      sinceRevision: 2
    })
    expect(writeMock).toHaveBeenCalledWith(
      '{"resetRequired":false,"revision":2,"deltas":[{"revision":2}]}\n'
    )
  })

  it('uses explicit Canvas and browser lifecycle operations', async () => {
    await MAESTRO_HANDLERS['maestro open'](
      context([
        ['host', 'local'],
        ['workspace', 'folder:workspace_1']
      ])
    )
    await MAESTRO_HANDLERS['maestro browser-surface focus'](context([['payload', '{}']]))
    await MAESTRO_HANDLERS['maestro browser-surface capture'](context([['payload', '{}']]))
    await MAESTRO_HANDLERS['maestro browser-surface retain'](context([['payload', '{}']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'maestro.canvas.open', {
      execution_host_id: 'local',
      workspace_key: 'folder:workspace_1'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.browserSurface.focus', {})
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.browserSurface.capture', {})
    expect(callMock).toHaveBeenNthCalledWith(4, 'orchestration.browserSurface.retain', {})
  })
})
