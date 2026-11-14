import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime/client', () => {
  class RuntimeClient {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }
  return { RuntimeClient }
})

import { main } from '../index'

describe('orca cli storage set preserves an empty value', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // PowerShell 5.1 drops empty native arguments; equals form preserves them.

  it('still rejects an empty --key before RPC dispatch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['storage', 'local', 'set', '--key', '', '--value', 'x', '--worktree', 'all'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Missing required --key')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('still rejects a missing --value before RPC dispatch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['storage', 'local', 'set', '--key', 'flag', '--worktree', 'all'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Missing required --value')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})

describe('orca cli cookie set and set credentials preserve an empty value', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('still rejects an empty --name before RPC dispatch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['cookie', 'set', '--name', '', '--value', 'x', '--worktree', 'all'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Missing required --name')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('still rejects a missing --pass before RPC dispatch', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['set', 'credentials', '--user', 'token', '--worktree', 'all'],
      '/tmp/not-an-orca-worktree'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Missing required --pass')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
