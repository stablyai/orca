import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, args: { id: string }) => Promise<unknown>
type Session = { id: string; rootProcessId?: number; wslDistro?: string }

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sessions: new Array<Session>(),
  hasProvider: vi.fn<(id: string) => boolean>(),
  findPaneCodexOnSharedServer:
    vi.fn<
      (id: string, rootPid: number) => Promise<{ command: string; shell: string | null } | null>
    >(),
  resolveCodexPaneHome: vi.fn<(id: string) => string | null>(),
  disable: vi.fn<(home: string) => Promise<boolean>>(),
  stop: vi.fn<(home: string) => Promise<boolean>>(),
  legacyAdapters: new Array<{ protocolVersion: number; hasPty: (id: string) => boolean }>()
}))
vi.mock('../../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler)
  })
}))
vi.mock('../../../codex/codex-shared-server-pane', () => ({
  findPaneCodexOnSharedServer: mocks.findPaneCodexOnSharedServer,
  resolveCodexPaneHome: mocks.resolveCodexPaneHome
}))
vi.mock('../../../codex/codex-shared-server-fix', () => ({
  disableCodexSharedServerAutoStart: mocks.disable,
  stopCodexSharedServer: mocks.stop
}))
vi.mock('../../../daemon/daemon-provider-routing', () => ({
  getLegacyDaemonAdapters: () => mocks.legacyAdapters
}))
vi.mock('../provider/registry', () => ({
  hasPtyProviderForInspection: mocks.hasProvider,
  getProviderForPty: () => ({ listProcesses: () => Promise.resolve(mocks.sessions) })
}))

import { toAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from '../provider/ownership-state'
import { installPtyCodexSharedServerIpcHandler } from './codex-shared-server'

// Each channel with its answer for a local pane and its answer when it refuses one.
const CHANNELS = [
  ['pty:isCodexOnSharedServer', { joined: true, openedBeforeWrapper: false }, { joined: false }],
  ['pty:disableCodexSharedServerAutoStart', true, false],
  ['pty:stopCodexSharedServer', true, false]
] as const

function invoke(channel: string, id: string): Promise<unknown> {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`missing ${channel}`)
  }
  return handler({}, { id })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  ptyOwnership.clear()
  mocks.sessions = [{ id: 'local-1', rootProcessId: 100 }]
  mocks.hasProvider.mockReturnValue(true)
  mocks.findPaneCodexOnSharedServer.mockResolvedValue({ command: 'codex', shell: 'zsh' })
  mocks.resolveCodexPaneHome.mockReturnValue('/home/me/.codex')
  mocks.disable.mockResolvedValue(true)
  mocks.stop.mockResolvedValue(true)
  mocks.legacyAdapters = []
  installPtyCodexSharedServerIpcHandler({ getLocalPtyProviderStartupPromise: () => undefined })
})

describe('Codex shared-server IPC', () => {
  it.each(CHANNELS)('%s answers for a local pane', async (channel, answer) => {
    expect(await invoke(channel, 'local-1')).toEqual(answer)
  })

  const ownedBy = (protocolVersion: number, ptyId = 'local-1') => ({
    protocolVersion,
    hasPty: (id: string) => id === ptyId
  })

  it.each([
    ['zsh on a v36 daemon', 'zsh', [ownedBy(36)], true],
    ['zsh on a v37 daemon', 'zsh', [ownedBy(37)], false],
    ['fish on a v37 daemon', 'fish', [ownedBy(37)], true],
    ['fish on a v38 daemon', 'fish', [ownedBy(38)], true],
    ['fish on a v39 daemon', 'fish', [ownedBy(39)], false],
    ['cmd.exe, which never gets the codex function', 'cmd', [ownedBy(36)], false],
    ['an unknown shell', null, [ownedBy(36)], false],
    ['zsh where the older daemon does not hold this pane', 'zsh', [ownedBy(36, 'other')], false]
  ])('tells whether a new terminal would fix %s', async (_label, shell, adapters, old) => {
    mocks.findPaneCodexOnSharedServer.mockResolvedValue({ command: 'codex', shell })
    mocks.legacyAdapters = adapters
    expect(await invoke('pty:isCodexOnSharedServer', 'local-1')).toEqual({
      joined: true,
      openedBeforeWrapper: old
    })
  })

  it('reads no daemon owner for a pane that has not joined', async () => {
    const hasPty = vi.fn(() => true)
    mocks.legacyAdapters = [{ protocolVersion: 36, hasPty }]
    mocks.findPaneCodexOnSharedServer.mockResolvedValue(null)
    expect(await invoke('pty:isCodexOnSharedServer', 'local-1')).toEqual({ joined: false })
    expect(hasPty).not.toHaveBeenCalled()
  })

  it('runs the fix against the pane home', async () => {
    await invoke('pty:disableCodexSharedServerAutoStart', 'local-1')
    await invoke('pty:stopCodexSharedServer', 'local-1')
    expect(mocks.resolveCodexPaneHome).toHaveBeenCalledWith('local-1')
    expect(mocks.disable).toHaveBeenCalledWith('/home/me/.codex')
    expect(mocks.stop).toHaveBeenCalledWith('/home/me/.codex')
  })

  const refusals: [string, string, () => void][] = [
    ['a remote runtime pane', 'remote:local-1', () => {}],
    ['an SSH pane', toAppSshPtyId('conn-1', 'local-1'), () => {}],
    [
      'a pane routed to an SSH connection',
      'local-1',
      () => ptyOwnership.set('local-1', 'ssh:conn-1')
    ],
    [
      'a WSL pane',
      'local-1',
      () => (mocks.sessions = [{ id: 'local-1', rootProcessId: 100, wslDistro: 'Ubuntu' }])
    ],
    ['a pane with no root pid', 'local-1', () => (mocks.sessions = [{ id: 'local-1' }])],
    ['a pane no provider holds', 'local-1', () => mocks.hasProvider.mockReturnValue(false)]
  ]

  it.each(
    CHANNELS.flatMap(([channel, , refused]) =>
      refusals.map((refusal) => [channel, ...refusal, refused] as const)
    )
  )('%s refuses %s', async (channel, _label, id, arrange, refused) => {
    arrange()
    expect(await invoke(channel, id)).toEqual(refused)
    expect(mocks.findPaneCodexOnSharedServer).not.toHaveBeenCalled()
    expect(mocks.disable).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })

  it.each(CHANNELS.slice(1))('%s runs nothing when the pane has no Codex home', async (channel) => {
    mocks.resolveCodexPaneHome.mockReturnValue(null)
    expect(await invoke(channel, 'local-1')).toBe(false)
    expect(mocks.disable).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })
})
