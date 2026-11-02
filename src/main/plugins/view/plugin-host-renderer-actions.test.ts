import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getPluginHostRendererActions,
  setPluginHostRendererRequest
} from './plugin-host-renderer-actions'

afterEach(() => setPluginHostRendererRequest(null))

describe('plugin host renderer actions', () => {
  it('are absent in headless serve, and unavailable with no window', async () => {
    expect(getPluginHostRendererActions()).toBeNull()
    setPluginHostRendererRequest(() => null)
    await expect(getPluginHostRendererActions()?.runAction('view.tasks')).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  it('send open-file and run-action, and map the window refusals', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ requestId: 'a', ok: true })
      .mockResolvedValueOnce({ requestId: 'b', ok: false, code: 'no_workspace', message: 'none' })
      .mockResolvedValueOnce({ requestId: 'c', ok: false, code: 'renderer_error', message: 'boom' })
      .mockRejectedValueOnce(new Error('renderer_unavailable'))
    setPluginHostRendererRequest(request)
    const actions = getPluginHostRendererActions()!
    await expect(actions.openFile('app', 'src/a.ts')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith({
      kind: 'open-file',
      worktreeId: 'app',
      relativePath: 'src/a.ts'
    })
    await expect(actions.runAction('view.tasks')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(actions.runAction('view.tasks')).rejects.toMatchObject({ code: 'action_failed' })
    await expect(actions.runAction('view.tasks')).rejects.toMatchObject({ code: 'unavailable' })
    expect(request).toHaveBeenLastCalledWith({ kind: 'run-action', action: 'view.tasks' })
  })
})
