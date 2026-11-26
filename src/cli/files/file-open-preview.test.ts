import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

type RuntimeClientModule = typeof RuntimeClientExports

vi.mock('../runtime/client', async (importOriginal) => ({
  ...(await importOriginal<RuntimeClientModule>()),
  RuntimeClient: class {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }
}))

import { main } from '../index'
import type * as RuntimeClientExports from '../runtime/client'

describe('orca file open --preview', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks for a preview only when --preview is passed', async () => {
    const opened = { worktree: 'wt-1', relativePath: 'a.html', kind: 'text', opened: true }
    const reply = { id: 'open', ok: true, result: opened, _meta: { runtimeId: 'runtime-1' } }
    callMock.mockResolvedValueOnce(reply).mockResolvedValueOnce(reply)
    await main(['file', 'open', 'a.html', '--preview', '--worktree', 'id:wt-1'], '/tmp/repo')
    await main(['file', 'open', 'a.html', '--worktree', 'id:wt-1'], '/tmp/repo')
    expect(callMock.mock.calls.map(([, params]) => params)).toEqual([
      { worktree: 'id:wt-1', relativePath: 'a.html', navigation: 'caller', preview: true },
      { worktree: 'id:wt-1', relativePath: 'a.html', navigation: 'caller' }
    ])
  })

  it('rejects --preview with --line before resolving a workspace', async () => {
    await main(['file', 'open', 'a.ts', '--preview', '--line', '2'], '/tmp/repo')
    expect(process.exitCode).toBe(1)
    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toMatch(/--(?:line|column)/)
    process.exitCode = undefined
  })
})
