import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { parseArgs } from '../args'
import { printHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import { TERMINAL_HANDLERS } from './terminal'
import { AGENT_SESSION_ACCOUNT_REF_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

describe('terminal close CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the default close RPC unchanged', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { close: { handle: 'term-1', tabId: 'tab-1', ptyKilled: true } }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal close']({
      flags: new Map([['terminal', 'term-1']]),
      client: { call } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('terminal.close', { terminal: 'term-1' })
  })

  it('routes --tab to the durable whole-tab RPC', async () => {
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

describe('terminal create account selection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves a canonical UUID and sends only the structured account launch', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return { result: { capabilities: [AGENT_SESSION_ACCOUNT_REF_RUNTIME_CAPABILITY] } }
      }
      if (method === 'accounts.list') {
        return {
          result: {
            codex: {
              accounts: [
                {
                  id: 'account-a',
                  email: 'user@example.com',
                  managedHomeRuntime: 'wsl',
                  wslDistro: 'Ubuntu'
                }
              ],
              activeAccountId: null
            }
          }
        }
      }
      return {
        result: {
          disposition: 'created',
          terminal: { handle: 'term-account-a', worktreeId: 'worktree-1', title: null }
        }
      }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal create']({
      flags: new Map([
        ['worktree', 'id:worktree-1'],
        ['agent', 'codex'],
        ['account', 'account-a']
      ]),
      client: { call, isRemote: false } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).toHaveBeenCalledWith('accounts.list', { refreshUsage: false })
    expect(call).toHaveBeenCalledWith(
      'terminal.createAgentSession',
      expect.objectContaining({
        clientOperationId: expect.stringMatching(/^\d+-[a-f0-9]{32}$/),
        worktree: 'id:worktree-1',
        agent: 'codex',
        providerAccountRef: {
          provider: 'codex',
          accountId: 'account-a',
          runtime: 'wsl',
          wslDistro: 'Ubuntu'
        },
        presentation: 'background'
      })
    )
    expect(call).not.toHaveBeenCalledWith('terminal.create', expect.anything())
  })

  it('selects an explicit WSL system account without listing managed homes', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'status.get'
        ? { result: { capabilities: [AGENT_SESSION_ACCOUNT_REF_RUNTIME_CAPABILITY] } }
        : {
            result: {
              disposition: 'created',
              terminal: { handle: 'term-system', worktreeId: 'worktree-1', title: null }
            }
          }
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await TERMINAL_HANDLERS['terminal create']({
      flags: new Map([
        ['worktree', 'id:worktree-1'],
        ['agent', 'codex'],
        ['account', 'system'],
        ['account-runtime', 'wsl'],
        ['wsl-distro', 'Ubuntu']
      ]),
      client: { call, isRemote: false } as unknown as RuntimeClient,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(call).not.toHaveBeenCalledWith('accounts.list', expect.anything())
    expect(call).toHaveBeenCalledWith(
      'terminal.createAgentSession',
      expect.objectContaining({
        providerAccountRef: {
          provider: 'codex',
          accountId: null,
          runtime: 'wsl',
          wslDistro: 'Ubuntu'
        }
      })
    )
  })

  it('fails before account lookup or launch when the runtime lacks the capability', async () => {
    const call = vi.fn().mockResolvedValue({ result: { capabilities: [] } })

    await expect(
      TERMINAL_HANDLERS['terminal create']({
        flags: new Map([
          ['worktree', 'id:worktree-1'],
          ['agent', 'codex'],
          ['account', 'account-a']
        ]),
        client: { call, isRemote: false } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toThrow('does not support account-scoped agent launches')

    expect(call).toHaveBeenCalledTimes(1)
    expect(call).not.toHaveBeenCalledWith('terminal.createAgentSession', expect.anything())
  })

  it('does not accept an email or deleted UUID as an account selector', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'status.get'
        ? { result: { capabilities: [AGENT_SESSION_ACCOUNT_REF_RUNTIME_CAPABILITY] } }
        : { result: { codex: { accounts: [], activeAccountId: null } } }
    )

    await expect(
      TERMINAL_HANDLERS['terminal create']({
        flags: new Map([
          ['worktree', 'id:worktree-1'],
          ['agent', 'codex'],
          ['account', 'user@example.com']
        ]),
        client: { call, isRemote: false } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toThrow('Unknown Codex account UUID')

    expect(call).not.toHaveBeenCalledWith('terminal.createAgentSession', expect.anything())
  })

  it('rejects a valueless account flag instead of silently creating a default terminal', async () => {
    const call = vi.fn()

    await expect(
      TERMINAL_HANDLERS['terminal create']({
        flags: new Map([['account', true]]),
        client: { call, isRemote: false } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toThrow('Missing required --account')

    expect(call).not.toHaveBeenCalled()
  })

  it('fails closed when a managed WSL account has no distribution', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'status.get'
        ? { result: { capabilities: [AGENT_SESSION_ACCOUNT_REF_RUNTIME_CAPABILITY] } }
        : {
            result: {
              codex: {
                accounts: [
                  { id: 'broken-wsl', email: 'user@example.com', managedHomeRuntime: 'wsl' }
                ],
                activeAccountId: null
              }
            }
          }
    )

    await expect(
      TERMINAL_HANDLERS['terminal create']({
        flags: new Map([
          ['agent', 'codex'],
          ['account', 'broken-wsl']
        ]),
        client: { call, isRemote: false } as unknown as RuntimeClient,
        cwd: '/tmp/worktree',
        json: true
      })
    ).rejects.toThrow('has no WSL distribution')

    expect(call).not.toHaveBeenCalledWith('terminal.createAgentSession', expect.anything())
  })
})
