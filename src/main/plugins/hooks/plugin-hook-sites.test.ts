import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookName } from '../../../shared/plugins/contributions/plugin-hook-contribution'
import type { PluginHookChainOutcome } from '../../../shared/plugins/workers/plugin-hook-chain'
import { terminalSendPluginHook } from '../../runtime/terminal/input/terminal-send-plugin-hook'
import { PluginHookDeniedError, setPluginHookRunner } from './plugin-hook-dispatch'
import {
  applyWorkspaceCreatePluginHook,
  notifyWorkspaceCreatedPluginHook
} from './workspace-create-plugin-hook'

type Decide = (event: PluginHookName, payload: unknown) => PluginHookChainOutcome

function installRunner(decide: Decide, wanted: readonly PluginHookName[] = []) {
  const run = vi.fn(async (event: PluginHookName, payload: unknown) => decide(event, payload))
  setPluginHookRunner({ wants: (event) => wanted.includes(event), run })
  return run
}

const rewrite =
  (changes: Record<string, unknown>): Decide =>
  (_event, payload) => ({
    kind: 'continue',
    payload: typeof payload === 'object' ? { ...payload, ...changes } : payload
  })

afterEach(() => {
  setPluginHookRunner(null)
})

describe('terminal.send hook site', () => {
  it('adds nothing when no plugin lists the hook, or for query replies and bare keys', () => {
    const run = installRunner(rewrite({}), [])
    expect(terminalSendPluginHook('t', { text: 'ls' }, 'driving')).toBeNull()
    installRunner(rewrite({}), ['terminal.send'])
    expect(terminalSendPluginHook('t', { text: '\x1b[0n' }, 'query-reply')).toBeNull()
    expect(terminalSendPluginHook('t', { enter: true }, 'driving')).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('sends what the chain decided and keeps an interrupt', async () => {
    const run = installRunner(rewrite({ text: 'ls -la', enter: false }), ['terminal.send'])
    await expect(
      terminalSendPluginHook('term_1', { text: 'ls', enter: true, interrupt: true }, 'launch')
    ).resolves.toEqual({ text: 'ls -la', enter: false, interrupt: true })
    expect(run).toHaveBeenCalledWith('terminal.send', {
      terminalId: 'term_1',
      text: 'ls',
      enter: true,
      inputKind: 'launch'
    })
  })

  it('refuses the send when a plugin denies it', async () => {
    installRunner(
      () => ({ kind: 'deny', pluginKey: 'acme.guard', reason: 'no rm' }),
      ['terminal.send']
    )
    const sent = terminalSendPluginHook('t', { text: 'rm -rf /' }, 'orchestration')
    await expect(sent).rejects.toBeInstanceOf(PluginHookDeniedError)
    await expect(sent).rejects.toThrow('terminal.send denied by plugin acme.guard: no rm')
  })
})

describe('workspace.create hook sites', () => {
  const worktree = { id: 'repo-1', kind: 'git' as const }
  const folder = { id: 'repo-2', kind: 'folder' as const }

  it('applies a changed name, branch and base to a worktree request', async () => {
    const run = installRunner(rewrite({ name: 'feat-x', branch: 'me/feat-x', base: undefined }), [
      'workspace.create.before'
    ])
    const request = { name: 'x', baseBranch: 'origin/main', linkedPR: 4 }
    await expect(applyWorkspaceCreatePluginHook(request, worktree)).resolves.toEqual({
      name: 'feat-x',
      branchNameOverride: 'me/feat-x',
      baseBranch: undefined,
      linkedPR: 4
    })
    expect(run).toHaveBeenCalledWith('workspace.create.before', {
      kind: 'worktree',
      projectId: 'repo-1',
      name: 'x',
      base: 'origin/main'
    })
  })

  it('gives folder workspaces only a name to change', async () => {
    const run = installRunner(rewrite({ name: 'notes', branch: 'ignored' }), [
      'workspace.create.before'
    ])
    await expect(applyWorkspaceCreatePluginHook({ name: 'n' }, folder)).resolves.toEqual({
      name: 'notes'
    })
    expect(run).toHaveBeenCalledWith('workspace.create.before', {
      kind: 'folder',
      projectId: 'repo-2',
      name: 'n'
    })
  })

  it('refuses the create on a deny and passes the request through when unhooked', async () => {
    installRunner(
      () => ({ kind: 'deny', pluginKey: 'acme.naming', reason: 'bad name' }),
      ['workspace.create.before']
    )
    await expect(applyWorkspaceCreatePluginHook({ name: 'x' }, worktree)).rejects.toThrow(
      'workspace.create.before denied by plugin acme.naming: bad name'
    )
    setPluginHookRunner(null)
    const request = { name: 'x' }
    await expect(applyWorkspaceCreatePluginHook(request, worktree)).resolves.toBe(request)
  })

  it('tells observers about created worktrees and folders without waiting', () => {
    const run = installRunner(rewrite({}), ['workspace.create.after'])
    notifyWorkspaceCreatedPluginHook({
      worktreeId: 'repo-1::/w',
      path: '/w',
      branch: 'refs/heads/feat',
      folder: false
    })
    notifyWorkspaceCreatedPluginHook({
      worktreeId: 'folder:f',
      path: '/f',
      branch: '',
      folder: true
    })
    expect(run.mock.calls).toEqual([
      [
        'workspace.create.after',
        { workspaceId: 'repo-1::/w', kind: 'worktree', path: '/w', branch: 'feat' }
      ],
      [
        'workspace.create.after',
        { workspaceId: 'folder:f', kind: 'folder', path: '/f', branch: '' }
      ]
    ])
  })
})
