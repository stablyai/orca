import { describe, expect, it, vi } from 'vitest'
import { stopPtyProcessTree, TerminalSessionTeardown } from './terminal-session-teardown'
import type { ProcessTableCapture } from '../pty-descendant-termination'
import type { Session } from './session'

const ROOT_STARTED_AT = 'Mon Aug 24 08:00:00 2026'
const CHILD_STARTED_AT = 'Mon Aug 24 08:00:01 2026'
const INCARNATION = '11111111-1111-4111-8111-111111111111'

function capture(rows: ProcessTableCapture['rows']): ProcessTableCapture {
  return { rows, capturedAtMs: Date.parse('2026-08-24T08:01:00Z') }
}

describe('stopPtyProcessTree', () => {
  it('proves every pre-stop POSIX identity absent before returning exited', async () => {
    const readTable = vi
      .fn()
      .mockResolvedValueOnce(
        capture([
          { pid: 41, ppid: 1, pgid: 41, startedAt: ROOT_STARTED_AT },
          { pid: 42, ppid: 41, pgid: 99, startedAt: CHILD_STARTED_AT }
        ])
      )
      .mockResolvedValueOnce(capture([]))
      .mockResolvedValueOnce(capture([]))
    const sendSignal = vi.fn()
    const killRoot = vi.fn()

    const result = await stopPtyProcessTree(41, killRoot, {
      platform: 'linux',
      graceMs: 0,
      readTable,
      sendSignal
    })

    expect(sendSignal).toHaveBeenCalledWith(42, 'SIGTERM')
    expect(killRoot).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ verdict: 'exited', processTreeVerified: true })
    expect(result.observations.map(({ status }) => status)).toEqual(['absent', 'absent'])
  })

  it('fails closed when the pre-stop snapshot is unavailable', async () => {
    const killRoot = vi.fn()
    const result = await stopPtyProcessTree(41, killRoot, {
      platform: 'linux',
      readTable: vi.fn().mockRejectedValue(new Error('ps failed'))
    })

    expect(killRoot).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ verdict: 'unverifiable', processTreeVerified: false })
  })

  it('returns capability_limited on Windows after the identity-gated tree kill', async () => {
    const killRoot = vi.fn()
    const killWindowsTree = vi.fn().mockResolvedValue(undefined)
    const result = await stopPtyProcessTree(41, killRoot, {
      platform: 'win32',
      verifyTreeKillTarget: vi.fn().mockResolvedValue('own'),
      killWindowsTree
    })

    expect(killWindowsTree).toHaveBeenCalledWith(41)
    expect(killRoot).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ verdict: 'capability_limited', processTreeVerified: false })
  })
})

describe('TerminalSessionTeardown stop receipts', () => {
  it('does not invent a receipt when termination ownership is unavailable', () => {
    const session = {
      pid: 41,
      incarnationId: INCARNATION,
      terminalHandle: 'terminal-1',
      isAlive: true,
      beginTermination: vi.fn(() => false)
    } as unknown as Session
    const teardown = new TerminalSessionTeardown(new Map([['pty-1', session]]))

    expect(() => teardown.killSession('pty-1', session, true)).toThrow(
      'stop identity is unavailable'
    )
    expect(session.beginTermination).toHaveBeenCalledOnce()
  })
})
