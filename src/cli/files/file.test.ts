import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime/client', () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode?: string | null,
      environmentSelector?: string | null
    ) {
      this.isRemote = Boolean(remotePairingCode || environmentSelector)
    }
  }

  return { RuntimeClient }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca file CLI handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('fails an unopened direct diff instead of exiting 0', async () => {
    queueFixtures(
      callMock,
      okFixture('req_diff', {
        worktree: 'wt-1',
        relativePath: 'assets/logo.png',
        kind: 'binary',
        opened: false
      })
    )

    await main(['file', 'diff', '--path', 'assets/logo.png', '--worktree', 'id:wt-1'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('files.openDiff', {
      worktree: 'id:wt-1',
      relativePath: 'assets/logo.png',
      staged: false,
      navigation: 'caller'
    })
    expect(console.log).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Did not open diff for assets/logo.png: the Orca app declined this binary file.'
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })

  it('fails an unopened file open with ok:false in --json mode', async () => {
    queueFixtures(
      callMock,
      okFixture('req_open', {
        worktree: 'wt-1',
        relativePath: 'docs/example.pdf',
        kind: 'binary',
        opened: false
      })
    )

    await main(
      ['file', 'open', '--path', 'docs/example.pdf', '--worktree', 'id:wt-1', '--json'],
      '/tmp/repo'
    )

    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output).toMatchObject({ ok: false })
    expect(output.error.message).toContain('Did not open docs/example.pdf')
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })

  it('requires an explicit worktree for remote file commands', async () => {
    const priorExitCode = process.exitCode

    await main(['file', 'open-changed', '--pairing-code', 'remote-runtime'], '/tmp/repo/src')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Remote file commands require --worktree'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })
})
