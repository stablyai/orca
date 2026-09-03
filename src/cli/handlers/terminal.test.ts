import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { parseArgs } from '../args'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import { TERMINAL_HANDLERS } from './terminal'
import { TERMINAL_IDENTITY_PROOF_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

const ORIGINAL_EXIT_CODE = process.exitCode

describe('terminal close CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
  })

  it('keeps the default close RPC unchanged', async () => {
    process.exitCode = undefined
    const call = vi.fn().mockResolvedValue({
      id: 'req-close',
      ok: true,
      result: { close: { handle: 'term-1', tabId: 'tab-1', ptyKilled: true } },
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map([['terminal', 'term-1']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.close', { terminal: 'term-1' })
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      result: { close: { ptyKilled: true } }
    })
    expect(process.exitCode).toBeUndefined()
  })

  it('reports an unverifiable PTY stop as a failing JSON outcome', async () => {
    process.exitCode = undefined
    const close = {
      handle: 'term-remote',
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable' as const,
      ptyStopReason: 'its SSH provider is no longer registered'
    }
    const call = vi.fn().mockResolvedValue({
      id: 'req-close',
      ok: true,
      result: { close },
      _meta: { runtimeId: 'runtime-1' }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map([['terminal', close.handle]]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'terminal_stop_unverifiable',
        message: expect.stringContaining('unverifiable'),
        data: { close }
      }
    })
    expect(process.exitCode).toBe(1)
  })

  it('reports a live PTY stop as a failing human outcome', async () => {
    process.exitCode = undefined
    const close = {
      handle: 'term-live',
      tabId: 'tab-1',
      ptyKilled: false,
      ptyStopVerdict: 'live' as const
    }
    const call = vi.fn().mockResolvedValue({ result: { close } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map([['terminal', close.handle]]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: false
    })

    expect(log).toHaveBeenCalledWith(expect.stringContaining('The PTY is live.'))
    expect(process.exitCode).toBe(1)
  })

  it('routes --tab to the durable whole-tab RPC', async () => {
    process.exitCode = undefined
    const parsed = parseArgs(['terminal', 'close', '--terminal', 'term-1', '--tab'])
    const call = vi.fn().mockResolvedValue({
      result: {
        close: {
          handle: 'term-1',
          tabId: 'tab-1',
          closeMode: 'tab',
          ptyKilled: false
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: parsed.flags,
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(parsed.flags.get('tab')).toBe(true)
    expect(call).toHaveBeenCalledWith('terminal.closeTab', { terminal: 'term-1' })
    expect(process.exitCode).toBeUndefined()
  })

  it('documents that --tab waits for durable persistence', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(COMMAND_SPECS, ['terminal', 'close'])

    const help = String(log.mock.calls[0]?.[0])
    expect(help).toContain('orca terminal close [--terminal <handle>] [--tab] [--json]')
    expect(help).toContain('durable persistence')
  })
})

describe('terminal send CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
  })

  it('marks combined text and Enter as an agent prompt candidate', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 7 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.send', {
      terminal: 'term-1',
      text: 'review',
      enter: true,
      interrupt: false,
      agentPrompt: true,
      client: { id: 'orca-cli', type: 'desktop' }
    })
  })

  it('explains that Structured Chat blocked a refused send and how to recover', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        send: {
          handle: 'term-1',
          accepted: false,
          bytesWritten: 0,
          agentSessionRefusal: {
            code: 'agent_session_conflict',
            sessionId: 'session-1',
            ownerRuntimeKind: 'native',
            handoffStage: null,
            ownerPid: 4242,
            runtimeFence: 7
          }
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'review'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: false
    })

    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/Structured Chat.*Switch it to Terminal.*orca terminal send/s)
    )
    expect(process.exitCode).toBe(1)
  })

  it('keeps text-only and bare Enter sends as direct terminal input', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { send: { handle: 'term-1', accepted: true, bytesWritten: 1 } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['text', 'x']
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })
    await TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | true>([
        ['terminal', 'term-1'],
        ['enter', true]
      ]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(1, 'terminal.send', {
      terminal: 'term-1',
      text: 'x',
      enter: false,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
    expect(call).toHaveBeenNthCalledWith(2, 'terminal.send', {
      terminal: 'term-1',
      text: undefined,
      enter: true,
      interrupt: false,
      client: { id: 'orca-cli', type: 'desktop' }
    })
  })
})

describe('terminal identity proof CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preflights the capability before issuing and completing a proof', async () => {
    const challengeId = '00000000-0000-4000-8000-000000000001'
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: { capabilities: [TERMINAL_IDENTITY_PROOF_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({
        result: {
          proof: {
            challengeId,
            marker: 'ORCA_TERMINAL_IDENTITY_PROOF_V1:marker',
            expiresAt: 100,
            worktreeId: 'repo::/worktree',
            executionHostId: 'local'
          }
        }
      })
      .mockResolvedValueOnce({
        result: { capabilities: [TERMINAL_IDENTITY_PROOF_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({
        result: {
          proof: {
            rename: { handle: 'term-1', tabId: 'tab-1', title: 'agent-name' },
            binding: {
              handle: 'term-1',
              worktreeId: 'repo::/worktree',
              tabId: 'tab-1',
              leafId: 'leaf-1',
              ptyId: 'pty-1',
              incarnationId: 'inc-1',
              executionHostId: 'local',
              topologyRevision: 1
            }
          }
        }
      })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const client = { call } as unknown as RuntimeClient

    await TERMINAL_HANDLERS['terminal identity-proof begin']({
      flags: new Map([['worktree', 'path:/tmp/worktree']]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })
    await TERMINAL_HANDLERS['terminal identity-proof complete']({
      flags: new Map([
        ['challenge', challengeId],
        ['title', 'agent-name']
      ]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(1, 'status.get')
    expect(call).toHaveBeenNthCalledWith(2, 'terminal.identityProof.begin', {
      worktree: 'path:/tmp/worktree'
    })
    expect(call).toHaveBeenNthCalledWith(3, 'status.get')
    expect(call).toHaveBeenNthCalledWith(4, 'terminal.identityProof.complete', {
      challengeId,
      title: 'agent-name'
    })
  })

  it('does not call proof or rename methods against an older host', async () => {
    const call = vi.fn().mockResolvedValue({ result: { capabilities: [] } })

    await expect(
      TERMINAL_HANDLERS['terminal identity-proof begin']({
        flags: new Map([['worktree', 'path:/tmp/worktree']]),
        client: { call } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('within the authoritative worktree scope')
    })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('status.get')
  })
})
