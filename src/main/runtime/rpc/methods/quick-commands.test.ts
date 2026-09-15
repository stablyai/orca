import { describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { QUICK_COMMAND_METHODS } from './quick-commands'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const globalCommand: TerminalQuickCommand = {
  id: 'qc-global',
  label: 'Run tests',
  scope: { type: 'global' },
  action: 'terminal-command',
  command: 'pnpm test',
  appendEnter: true
}

const repoCommand: TerminalQuickCommand = {
  id: 'qc-repo',
  label: 'Build',
  scope: { type: 'repo', repoId: 'repo-1' },
  action: 'terminal-command',
  command: 'pnpm build',
  appendEnter: true
}

const otherRepoCommand: TerminalQuickCommand = {
  id: 'qc-other',
  label: 'Other',
  scope: { type: 'repo', repoId: 'repo-2' },
  action: 'terminal-command',
  command: 'echo other',
  appendEnter: true
}

function makeDispatcher(commands: TerminalQuickCommand[] = []) {
  const updateClientTerminalQuickCommands = vi.fn(() => commands)
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientTerminalQuickCommands: vi.fn(() => commands),
    updateClientTerminalQuickCommands,
    showRepo: vi.fn(async () => ({ id: 'repo-1' })),
    showManagedWorktree: vi.fn(async () => ({ repoId: 'repo-1' }))
  } as unknown as OrcaRuntimeService
  return {
    dispatcher: new RpcDispatcher({ runtime, methods: QUICK_COMMAND_METHODS }),
    runtime,
    updateClientTerminalQuickCommands
  }
}

describe('quick command RPC methods', () => {
  it('defaults to every command when no target is given', async () => {
    const { dispatcher } = makeDispatcher([globalCommand, repoCommand, otherRepoCommand])

    const response = await dispatcher.dispatch(makeRequest('quickCommand.list', {}))

    expect(response).toMatchObject({
      ok: true,
      result: { repoId: null, quickCommands: [globalCommand, repoCommand, otherRepoCommand] }
    })
  })

  it('defaults to the applicable set once a worktree is given', async () => {
    const { dispatcher } = makeDispatcher([globalCommand, repoCommand, otherRepoCommand])

    const response = await dispatcher.dispatch(
      makeRequest('quickCommand.list', { worktree: 'active' })
    )

    expect(response).toMatchObject({
      ok: true,
      result: { repoId: 'repo-1', quickCommands: [globalCommand, repoCommand] }
    })
  })

  it('narrows to a single repo with --scope repo', async () => {
    const { dispatcher } = makeDispatcher([globalCommand, repoCommand, otherRepoCommand])

    const response = await dispatcher.dispatch(
      makeRequest('quickCommand.list', { repo: 'name:alpha', scope: 'repo' })
    )

    expect(response).toMatchObject({ ok: true, result: { quickCommands: [repoCommand] } })
  })

  it('rejects a repo-scoped listing with no repo or worktree', async () => {
    const { dispatcher } = makeDispatcher([globalCommand])

    const response = await dispatcher.dispatch(makeRequest('quickCommand.list', { scope: 'repo' }))

    expect(response).toMatchObject({ ok: false })
  })

  it('rejects an unknown list scope before reaching the runtime', async () => {
    const { dispatcher, runtime } = makeDispatcher()

    const response = await dispatcher.dispatch(
      makeRequest('quickCommand.list', { scope: 'workspace' })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.getClientTerminalQuickCommands).not.toHaveBeenCalled()
  })

  it('creates a repo-scoped command as a single upsert', async () => {
    const { dispatcher, updateClientTerminalQuickCommands } = makeDispatcher([])

    const response = await dispatcher.dispatch(
      makeRequest('quickCommand.create', {
        label: 'Run tests',
        command: 'pnpm test',
        worktree: 'active',
        appendEnter: false
      })
    )

    expect(updateClientTerminalQuickCommands).toHaveBeenCalledWith({
      type: 'upsert',
      command: expect.objectContaining({
        label: 'Run tests',
        command: 'pnpm test',
        appendEnter: false,
        scope: { type: 'repo', repoId: 'repo-1' }
      })
    })
    expect(response).toMatchObject({ ok: true })
  })

  it('refuses to overwrite an existing id on create', async () => {
    const { dispatcher, updateClientTerminalQuickCommands } = makeDispatcher([globalCommand])

    const response = await dispatcher.dispatch(
      makeRequest('quickCommand.create', {
        id: 'qc-global',
        label: 'Clash',
        command: 'ls'
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(updateClientTerminalQuickCommands).not.toHaveBeenCalled()
  })

  it('leaves scope alone when neither repo nor global is passed', async () => {
    const { dispatcher, updateClientTerminalQuickCommands } = makeDispatcher([repoCommand])

    await dispatcher.dispatch(
      makeRequest('quickCommand.update', { id: 'qc-repo', label: 'Renamed' })
    )

    expect(updateClientTerminalQuickCommands).toHaveBeenCalledWith({
      type: 'upsert',
      command: expect.objectContaining({
        label: 'Renamed',
        scope: { type: 'repo', repoId: 'repo-1' }
      })
    })
  })

  it('moves a command back to global scope when asked', async () => {
    const { dispatcher, updateClientTerminalQuickCommands } = makeDispatcher([repoCommand])

    await dispatcher.dispatch(
      makeRequest('quickCommand.update', { id: 'qc-repo', global: true })
    )

    expect(updateClientTerminalQuickCommands).toHaveBeenCalledWith({
      type: 'upsert',
      command: expect.objectContaining({ scope: { type: 'global' } })
    })
  })

  it('rejects a body flag that does not match the stored action', async () => {
    const { dispatcher, updateClientTerminalQuickCommands } = makeDispatcher([globalCommand])

    const response = await dispatcher.dispatch(
      makeRequest('quickCommand.update', { id: 'qc-global', prompt: 'review the diff' })
    )

    expect(response).toMatchObject({ ok: false })
    expect(updateClientTerminalQuickCommands).not.toHaveBeenCalled()
  })

  it('deletes by id and echoes the removed command', async () => {
    const { dispatcher, updateClientTerminalQuickCommands } = makeDispatcher([globalCommand])

    const response = await dispatcher.dispatch(
      makeRequest('quickCommand.rm', { id: 'qc-global' })
    )

    expect(updateClientTerminalQuickCommands).toHaveBeenCalledWith({
      type: 'delete',
      id: 'qc-global'
    })
    expect(response).toMatchObject({ ok: true, result: { removed: { id: 'qc-global' } } })
  })

  it('reports an unknown id instead of writing', async () => {
    const { dispatcher, updateClientTerminalQuickCommands } = makeDispatcher([])

    const response = await dispatcher.dispatch(makeRequest('quickCommand.rm', { id: 'missing' }))

    expect(response).toMatchObject({ ok: false })
    expect(updateClientTerminalQuickCommands).not.toHaveBeenCalled()
  })
})
