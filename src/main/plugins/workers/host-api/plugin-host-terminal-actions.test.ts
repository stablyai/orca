import { describe, expect, it, vi } from 'vitest'
import type { PluginHostRendererActions } from '../../view/plugin-host-renderer-actions'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'

// The runtime's refusal of a handle it no longer knows, as the in-process RPC raises it.
const runtimeError = (code: string) =>
  Object.assign(new Error(`${code}: internal detail`), { code })
const renderer: PluginHostRendererActions = {
  openFile: vi.fn(),
  runAction: vi.fn(),
  openFolderWorkspace: vi.fn()
}

describe('terminal.list', () => {
  it("lists any workspace's terminals by the selector its id names", async () => {
    const rpc = vi.fn().mockResolvedValue({
      terminals: [
        { handle: 'term_a', title: 'zsh', paneTitle: 'Build' },
        { handle: 'term_b', title: null }
      ],
      totalCount: 60,
      truncated: false
    })
    const outcome = await callPluginHost({
      method: 'terminal.list',
      params: { workspaceId: 'identity:wt2:local:abc' },
      granted: ['workspace:read'],
      services: pluginHostTestServices(rpc)
    })
    expect(outcome).toEqual({
      ok: true,
      value: { terminals: [{ id: 'term_a', title: 'Build' }, { id: 'term_b' }], truncated: true }
    })
    expect(rpc).toHaveBeenCalledWith(
      'terminal.list',
      {
        worktree: 'identity:wt2:local:abc',
        limit: 50,
        includeVisualLayouts: false,
        includePreview: false
      },
      {}
    )
  })

  it('names an unknown workspace without the runtime wording', async () => {
    const rpc = vi.fn().mockRejectedValue(runtimeError('selector_not_found'))
    expect(
      await callPluginHost({
        method: 'terminal.list',
        params: { workspaceId: 'gone' },
        granted: ['workspace:read'],
        services: pluginHostTestServices(rpc)
      })
    ).toEqual({ ok: false, code: 'action_failed', error: 'no workspace has this id' })
  })
})

describe('terminal.focus', () => {
  it("focuses in this Orca's window only, never steering paired clients", async () => {
    const rpc = vi.fn().mockResolvedValue({ focus: { handle: 'term_a', navigated: true } })
    const audit = { record: vi.fn().mockResolvedValue(undefined) }
    const outcome = await callPluginHost({
      method: 'terminal.focus',
      params: { terminalId: 'term_a' },
      granted: ['workspace:write'],
      services: pluginHostTestServices(rpc, { renderer }),
      audit
    })
    expect(outcome).toEqual({ ok: true, value: { focused: true } })
    expect(rpc).toHaveBeenCalledWith(
      'terminal.focus',
      { terminal: 'term_a', navigation: 'host' },
      expect.anything()
    )
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.focus', summary: 'terminal=term_a' })
    )
  })

  it('is unavailable without a window, before asking the runtime', async () => {
    const rpc = vi.fn()
    expect(
      await callPluginHost({
        method: 'terminal.focus',
        params: { terminalId: 'term_a' },
        granted: ['workspace:write'],
        services: pluginHostTestServices(rpc)
      })
    ).toMatchObject({ ok: false, code: 'unavailable' })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('terminal.close', () => {
  const close = (rpc: PluginRuntimeRpc) =>
    callPluginHost({
      method: 'terminal.close',
      params: { terminalId: 'term_a' },
      granted: ['terminal:send'],
      services: pluginHostTestServices(rpc)
    })

  it('reports whether the process is known to have stopped', async () => {
    const answers = [
      { ptyKilled: true },
      { ptyKilled: false },
      { ptyKilled: false, ptyStopVerdict: 'live' },
      { ptyKilled: false, ptyStopVerdict: 'unverifiable' }
    ]
    const outcomes = await Promise.all(
      answers.map((answer) =>
        close(vi.fn().mockResolvedValue({ close: { handle: 'term_a', tabId: 't', ...answer } }))
      )
    )
    expect(outcomes.map((outcome) => outcome.ok && outcome.value)).toEqual([
      { closed: true, processExited: true },
      { closed: true, processExited: true },
      { closed: true, processExited: false },
      { closed: true, processExited: false }
    ])
  })

  it('names a stale or exited terminal without the runtime wording', async () => {
    const outcomes = await Promise.all(
      [runtimeError('terminal_handle_stale'), new Error('terminal_not_found')].map((error) =>
        close(vi.fn().mockRejectedValue(error))
      )
    )
    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        ok: false,
        code: 'action_failed',
        error: 'no live terminal has this id'
      })
    }
  })

  it('is refused before any runtime call without terminal:send', async () => {
    const rpc = vi.fn()
    expect(
      await callPluginHost({
        method: 'terminal.close',
        params: { terminalId: 'term_a' },
        granted: ['workspace:write'],
        services: pluginHostTestServices(rpc)
      })
    ).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(rpc).not.toHaveBeenCalled()
  })
})
