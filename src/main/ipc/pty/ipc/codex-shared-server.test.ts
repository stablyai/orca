import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, args: { id: string }) => Promise<boolean>
type Session = { id: string; rootProcessId?: number; wslDistro?: string }

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sessions: new Array<Session>(),
  hasProvider: vi.fn<(id: string) => boolean>(),
  isPaneCodexOnSharedServer: vi.fn<(id: string, rootPid: number) => Promise<boolean>>(),
  resolveCodexPaneHome: vi.fn<(id: string) => string | null>(),
  isOnOrcaMirror: vi.fn<(id: string) => boolean>(),
  disable: vi.fn<(home: string) => Promise<boolean>>(),
  disableOnMirror: vi.fn<(home: string) => Promise<boolean>>(),
  stop: vi.fn<(home: string) => Promise<boolean>>()
}))
vi.mock('../../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler)
  })
}))
vi.mock('../../../codex/codex-shared-server-pane', () => ({
  isCodexPaneOnOrcaMirrorHome: mocks.isOnOrcaMirror,
  isPaneCodexOnSharedServer: mocks.isPaneCodexOnSharedServer,
  resolveCodexPaneHome: mocks.resolveCodexPaneHome
}))
vi.mock('../../../codex/codex-shared-server-fix', () => ({
  disableCodexSharedServerAutoStart: mocks.disable,
  disableCodexSharedServerAutoStartOnOrcaMirror: mocks.disableOnMirror,
  stopCodexSharedServer: mocks.stop
}))
vi.mock('../provider/registry', () => ({
  hasPtyProviderForInspection: mocks.hasProvider,
  getProviderForPty: () => ({ listProcesses: () => Promise.resolve(mocks.sessions) })
}))

import { toAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from '../provider/ownership-state'
import { installPtyCodexSharedServerIpcHandler } from './codex-shared-server'

const CHANNELS = [
  'pty:isCodexOnSharedServer',
  'pty:disableCodexSharedServerAutoStart',
  'pty:stopCodexSharedServer'
] as const

function invoke(channel: string, id: string): Promise<boolean> {
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
  mocks.isPaneCodexOnSharedServer.mockResolvedValue(true)
  mocks.resolveCodexPaneHome.mockReturnValue('/home/me/.codex')
  mocks.isOnOrcaMirror.mockReturnValue(false)
  mocks.disable.mockResolvedValue(true)
  mocks.disableOnMirror.mockResolvedValue(true)
  mocks.stop.mockResolvedValue(true)
  installPtyCodexSharedServerIpcHandler({ getLocalPtyProviderStartupPromise: () => undefined })
})

describe('Codex shared-server IPC', () => {
  it.each(CHANNELS)('%s answers for a local pane', async (channel) => {
    expect(await invoke(channel, 'local-1')).toBe(true)
  })

  it('runs the fix against the pane home', async () => {
    await invoke('pty:disableCodexSharedServerAutoStart', 'local-1')
    await invoke('pty:stopCodexSharedServer', 'local-1')
    expect(mocks.resolveCodexPaneHome).toHaveBeenCalledWith('local-1')
    expect(mocks.disable).toHaveBeenCalledWith('/home/me/.codex')
    expect(mocks.stop).toHaveBeenCalledWith('/home/me/.codex')
    // Why: a real-home pane writes ~/.codex itself, so no mirror pass runs around it.
    expect(mocks.disableOnMirror).not.toHaveBeenCalled()
  })

  it('turns off a mirror-home pane through the mirror passes, not a bare write', async () => {
    mocks.isOnOrcaMirror.mockReturnValue(true)
    mocks.resolveCodexPaneHome.mockReturnValue('C:/orca/codex-runtime-home/home')
    expect(await invoke('pty:disableCodexSharedServerAutoStart', 'local-1')).toBe(true)
    expect(mocks.isOnOrcaMirror).toHaveBeenCalledWith('local-1')
    expect(mocks.disableOnMirror).toHaveBeenCalledWith('C:/orca/codex-runtime-home/home')
    expect(mocks.disable).not.toHaveBeenCalled()
  })

  const refusals: [string, string, () => void][] = [
    ['a remote runtime pane', 'remote:local-1', () => {}],
    ['an SSH pane', toAppSshPtyId('conn-1', 'local-1'), () => {}],
    ['a pane routed to an SSH connection', 'local-1', () => ptyOwnership.set('local-1', 'conn-1')],
    [
      'a WSL pane',
      'local-1',
      () => (mocks.sessions = [{ id: 'local-1', rootProcessId: 100, wslDistro: 'Ubuntu' }])
    ],
    ['a pane with no root pid', 'local-1', () => (mocks.sessions = [{ id: 'local-1' }])],
    ['a pane no provider holds', 'local-1', () => mocks.hasProvider.mockReturnValue(false)]
  ]

  it.each(CHANNELS.flatMap((channel) => refusals.map((refusal) => [channel, ...refusal] as const)))(
    '%s refuses %s',
    async (channel, _label, id, arrange) => {
      arrange()
      expect(await invoke(channel, id)).toBe(false)
      expect(mocks.isPaneCodexOnSharedServer).not.toHaveBeenCalled()
      expect(mocks.disable).not.toHaveBeenCalled()
      expect(mocks.disableOnMirror).not.toHaveBeenCalled()
      expect(mocks.stop).not.toHaveBeenCalled()
    }
  )

  it.each(CHANNELS.slice(1))('%s runs nothing when the pane has no Codex home', async (channel) => {
    mocks.resolveCodexPaneHome.mockReturnValue(null)
    expect(await invoke(channel, 'local-1')).toBe(false)
    expect(mocks.disable).not.toHaveBeenCalled()
    expect(mocks.disableOnMirror).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
  })
})
