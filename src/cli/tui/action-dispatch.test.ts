import { describe, expect, it, vi } from 'vitest'
import {
  buildCall,
  dispatchAction,
  isDestructive,
  worktreeSelector,
  type TuiCommand
} from './action-dispatch'
import type { TuiRpcClient } from './tui-rpc-client'

describe('buildCall', () => {
  it('builds worktree.create params with startupAgent/startupPrompt', () => {
    expect(
      buildCall({ kind: 'worktree.create', repo: 'id:r1', name: 'task', agent: 'codex' })
    ).toEqual({
      method: 'worktree.create',
      params: { repo: 'id:r1', name: 'task', startupAgent: 'codex', startupPrompt: undefined }
    })
  })

  it('maps the remaining worktree/terminal command kinds to their methods + selectors', () => {
    expect(buildCall({ kind: 'worktree.sleep', worktree: 'id:w' })).toEqual({
      method: 'worktree.sleep',
      params: { worktree: 'id:w' }
    })
    expect(buildCall({ kind: 'worktree.set', worktree: 'id:w', displayName: 'x' }).params).toEqual({
      worktree: 'id:w',
      displayName: 'x'
    })
    expect(
      buildCall({ kind: 'terminal.split', terminal: 't', direction: 'vertical' })
    ).toMatchObject({ method: 'terminal.split', params: { terminal: 't', direction: 'vertical' } })
    expect(buildCall({ kind: 'terminal.close', terminal: 't' })).toEqual({
      method: 'terminal.close',
      params: { terminal: 't' }
    })
    expect(buildCall({ kind: 'terminal.rename', terminal: 't', title: null }).params).toEqual({
      terminal: 't',
      title: null
    })
    expect(buildCall({ kind: 'terminal.stop', worktree: 'id:w' })).toEqual({
      method: 'terminal.stop',
      params: { worktree: 'id:w' }
    })
    expect(buildCall({ kind: 'terminal.focus', terminal: 't' })).toEqual({
      method: 'terminal.focus',
      params: { terminal: 't' }
    })
  })

  it('builds terminal.send with the TUI client descriptor', () => {
    const call = buildCall({ kind: 'terminal.send', terminal: 't1', text: 'hi', enter: true })
    expect(call.method).toBe('terminal.send')
    expect(call.params).toMatchObject({
      terminal: 't1',
      text: 'hi',
      enter: true,
      client: { id: 'orca-tui', type: 'desktop' }
    })
  })

  it('always passes an explicit worktree for terminal.create (remote-safe)', () => {
    const call = buildCall({
      kind: 'terminal.create',
      worktree: worktreeSelector('wt-9'),
      command: 'codex'
    })
    expect(call.params.worktree).toBe('id:wt-9')
  })

  it('builds worktree.rm with force', () => {
    expect(buildCall({ kind: 'worktree.rm', worktree: 'id:w', force: true }).params).toEqual({
      worktree: 'id:w',
      force: true
    })
  })

  it('builds orchestration.send and reply', () => {
    expect(
      buildCall({ kind: 'orchestration.send', from: 'a', to: 'b', subject: 'done' }).method
    ).toBe('orchestration.send')
    expect(buildCall({ kind: 'orchestration.reply', id: 'm1', from: 'a', body: 'ok' }).method).toBe(
      'orchestration.reply'
    )
  })
})

describe('isDestructive', () => {
  it('flags removal and stop/close commands', () => {
    expect(isDestructive({ kind: 'worktree.rm', worktree: 'x' })).toBe(true)
    expect(isDestructive({ kind: 'terminal.close', terminal: 't' })).toBe(true)
    expect(isDestructive({ kind: 'terminal.stop', worktree: 'x' })).toBe(true)
  })

  it('does not flag non-destructive commands', () => {
    expect(isDestructive({ kind: 'terminal.create', worktree: 'x' })).toBe(false)
    expect(isDestructive({ kind: 'worktree.activate', worktree: 'x' })).toBe(false)
  })
})

describe('dispatchAction', () => {
  it('calls the runtime with the built method and params', async () => {
    const call = vi.fn(async () => ({ result: {} }))
    const client = { call } as unknown as TuiRpcClient
    const command: TuiCommand = { kind: 'worktree.activate', worktree: 'id:w' }
    const result = await dispatchAction(client, command)
    expect(result).toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith('worktree.activate', { worktree: 'id:w' })
  })

  it('returns an error result instead of throwing when the RPC fails', async () => {
    const call = vi.fn(async () => {
      throw new Error('permission denied')
    })
    const client = { call } as unknown as TuiRpcClient
    const result = await dispatchAction(client, { kind: 'worktree.rm', worktree: 'id:w' })
    expect(result).toEqual({ ok: false, error: 'permission denied' })
  })
})
