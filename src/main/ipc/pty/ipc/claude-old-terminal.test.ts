import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noopPtyIpcSurface, setPtyHostBindings, type PtyIpcSurface } from '../pty-host-bindings'
import { ptyOwnership } from '../provider/ownership-state'
import { installPtyClaudeOldTerminalIpcHandler } from './claude-old-terminal'

const discovery = vi.hoisted(() => ({ discoverLocalPtyClaudeSession: vi.fn() }))
vi.mock('../../../claude-accounts/selection/claude-pane-session-discovery', () => discovery)

const CHANNEL = 'pty:discoverClaudeSession'
const SESSION = { key: 'session_id', id: 'session-1' }

type Listener = Parameters<PtyIpcSurface['handle']>[1]
const EVENT: IpcMainInvokeEvent = {
  frameId: 1,
  processId: 1,
  type: 'frame',
  senderFrame: null,
  defaultPrevented: false,
  preventDefault() {},
  get sender(): never {
    throw new Error('the lookup handler unexpectedly read the IPC sender')
  }
}

function install(
  startup?: Promise<void>,
  registered: Record<string, Listener> = {}
): (args: unknown) => unknown {
  const handlers = new Map<string, Listener>(Object.entries(registered))
  setPtyHostBindings({
    ipc: {
      ...noopPtyIpcSurface,
      handle: (channel, listener) => {
        if (handlers.has(channel)) {
          throw new Error(`second handler for ${channel}`)
        }
        handlers.set(channel, listener)
      },
      removeHandler: (channel) => handlers.delete(channel)
    }
  })
  installPtyClaudeOldTerminalIpcHandler({ getLocalPtyProviderStartupPromise: () => startup })
  return (args) => handlers.get(CHANNEL)?.(EVENT, args)
}

afterEach(() => {
  ptyOwnership.clear()
  discovery.discoverLocalPtyClaudeSession.mockReset()
  setPtyHostBindings({})
})

describe('pty:discoverClaudeSession', () => {
  it('looks a local pane up once the provider swap has settled', async () => {
    let settle = (): void => {}
    const startup = new Promise<void>((resolve) => (settle = resolve))
    discovery.discoverLocalPtyClaudeSession.mockResolvedValue(SESSION)
    const reply = install(startup)({ id: 'pty-1' })

    await Promise.resolve()
    expect(discovery.discoverLocalPtyClaudeSession).not.toHaveBeenCalled()
    settle()

    expect(await reply).toEqual(SESSION)
    expect(discovery.discoverLocalPtyClaudeSession).toHaveBeenCalledWith('pty-1')
  })

  it.each([
    ['no id', {}],
    ['an id that is not a string', { id: 42 }],
    ['a remote runtime pane', { id: 'remote:host-2:pty-1' }],
    ['an SSH pane', { id: 'ssh:conn-1@@relay-1' }],
    ['a pane another host owns', { id: 'pty-owned' }]
  ])('answers null without a lookup for %s', async (_label, args) => {
    ptyOwnership.set('pty-owned', 'runtime:host-2')

    expect(await install()(args)).toBeNull()
    expect(discovery.discoverLocalPtyClaudeSession).not.toHaveBeenCalled()
  })

  it('replaces a handler left from an earlier install', async () => {
    discovery.discoverLocalPtyClaudeSession.mockResolvedValue(SESSION)
    const stale: Listener = () => 'stale'

    expect(await install(undefined, { [CHANNEL]: stale })({ id: 'pty-1' })).toEqual(SESSION)
  })
})
