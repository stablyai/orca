import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QUICK_COMMAND_HANDLERS } from './quick-commands'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'

const callMock = vi.fn()
const client = { call: callMock } as unknown as RuntimeClient

function context(flags: Record<string, string | boolean>): HandlerContext {
  return {
    flags: new Map(Object.entries(flags)),
    client,
    cwd: '/tmp/repo',
    json: true
  }
}

async function run(command: string, flags: Record<string, string | boolean>): Promise<unknown> {
  await QUICK_COMMAND_HANDLERS[command](context(flags))
  return callMock.mock.calls.at(-1)?.[1]
}

describe('quick-command CLI handlers', () => {
  beforeEach(() => {
    callMock.mockReset()
    callMock.mockResolvedValue({
      ok: true,
      result: { quickCommands: [], quickCommand: {}, removed: {} }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends list scope and target selectors', async () => {
    expect(
      await run('quick-command list', { worktree: 'id:repo-1::/tmp/repo', scope: 'repo' })
    ).toStrictEqual({
      repo: undefined,
      worktree: 'id:repo-1::/tmp/repo',
      scope: 'repo'
    })
  })

  it('marks a create with --command as a terminal command', async () => {
    expect(
      await run('quick-command create', { label: 'Run tests', command: 'pnpm test' })
    ).toMatchObject({
      label: 'Run tests',
      command: 'pnpm test',
      action: 'terminal-command'
    })
  })

  it('marks a create with --agent as an agent prompt', async () => {
    expect(
      await run('quick-command create', {
        label: 'Review',
        agent: 'claude',
        prompt: 'review the diff'
      })
    ).toMatchObject({ action: 'agent-prompt', agent: 'claude', prompt: 'review the diff' })
  })

  it('maps --no-enter to appendEnter false and --enter to true', async () => {
    expect(
      await run('quick-command create', { label: 'Reset', command: 'reset', 'no-enter': true })
    ).toMatchObject({ appendEnter: false })
    expect(await run('quick-command set', { id: 'qc-1', enter: true })).toMatchObject({
      appendEnter: true
    })
  })

  it('leaves appendEnter and scope untouched when neither flag is passed', async () => {
    const params = (await run('quick-command set', { id: 'qc-1', label: 'Renamed' })) as Record<
      string,
      unknown
    >
    expect(params.appendEnter).toBeUndefined()
    expect('appendEnter' in params).toBe(true)
    expect(params.global).toBeUndefined()
    expect(params.repo).toBeUndefined()
    expect(params.worktree).toBeUndefined()
  })

  it('sends the global scope move', async () => {
    expect(await run('quick-command set', { id: 'qc-1', global: true })).toMatchObject({
      global: true
    })
  })

  it('removes and shows by id', async () => {
    expect(await run('quick-command rm', { id: 'qc-1' })).toEqual({ id: 'qc-1' })
    expect(await run('quick-command show', { id: 'qc-1' })).toEqual({ id: 'qc-1' })
  })

  it('requires an id for set, show, and rm', async () => {
    await expect(run('quick-command set', {})).rejects.toThrow(/Missing required --id/)
    await expect(run('quick-command show', {})).rejects.toThrow(/Missing required --id/)
    await expect(run('quick-command rm', {})).rejects.toThrow(/Missing required --id/)
  })
})
