import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { registerOrcadLiveMigrationHandlers } from './orcad-live-migration-handlers'
import type { OrcadLiveMigrationContext } from '../ssh/orcad-live-migration-selection'
import { RUNTIME_ENVIRONMENT_HANDLER_CHANNELS } from './runtime-environment-handler-channels'
import type * as rendererPlanModule from '../ssh/orcad-live-migration-renderer-plan'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  list: vi.fn(),
  resume: vi.fn(),
  start: vi.fn(),
  plan: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../ssh/orcad-live-migration-start', () => ({
  startSelectedOrcadLiveMigration: mocks.start
}))
vi.mock('../ssh/orcad-live-migration-renderer-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof rendererPlanModule>()),
  getOrcadLiveMigrationRendererPlan: mocks.plan
}))
vi.mock('../ssh/orcad-live-migration-selection', () => ({
  listSelectedOrcadLiveMigrations: mocks.list,
  resumeSelectedOrcadLiveMigration: mocks.resume
}))
const context = { store: {}, runtime: {} } as OrcadLiveMigrationContext
const selection = { selector: 'host', migrationId: 'migration', mode: 'recovery' }
beforeEach(() => {
  vi.resetAllMocks()
  registerOrcadLiveMigrationHandlers(() => '/trusted', context)
})
function handler(name: string) {
  return mocks.handle.mock.calls.find(([channel]) => channel === `runtimeEnvironments:${name}`)![1]
}
function sender(destroyed = false) {
  return Object.assign(new EventEmitter(), { isDestroyed: () => destroyed })
}

it('lists with trusted profile/store and registers removable channels', () => {
  mocks.list.mockReturnValue([])
  expect(
    handler('listOrcadLiveMigrations')(null, { selector: ' host ', store: 'injected' })
  ).toEqual([])
  expect(mocks.list).toHaveBeenCalledWith('/trusted', context.store, 'host')
  for (const [channel] of mocks.handle.mock.calls) {
    expect(RUNTIME_ENVIRONMENT_HANDLER_CHANNELS).toContain(channel)
  }
})
it('reads the renderer plan using only selection and main-owned evidence', () => {
  const result = { version: 1, workspaces: [] }
  mocks.plan.mockReturnValue(result)
  expect(
    handler('getOrcadLiveMigrationRendererPlan')(null, {
      selector: ' host ',
      migrationId: 'migration',
      profileDirectory: '/evil',
      record: { sha256: 'injected' }
    })
  ).toBe(result)
  expect(mocks.plan).toHaveBeenCalledWith('/trusted', context.store, {
    selector: 'host',
    migrationId: 'migration'
  })
})
it.each([{}, { selector: 'host' }, { selector: '', migrationId: 'migration' }])(
  'refuses invalid renderer plan selection %j before evidence reads',
  (args) => {
    expect(() => handler('getOrcadLiveMigrationRendererPlan')(null, args)).toThrow()
    expect(mocks.plan).not.toHaveBeenCalled()
  }
)
it('refuses renderer plans without context or completed evidence', () => {
  mocks.plan.mockImplementation(() => {
    throw new Error('completion_required')
  })
  expect(() => handler('getOrcadLiveMigrationRendererPlan')(null, selection)).toThrow(
    'completion_required'
  )
  mocks.handle.mockClear()
  registerOrcadLiveMigrationHandlers(() => '/trusted')
  expect(() => handler('getOrcadLiveMigrationRendererPlan')(null, selection)).toThrow('unavailable')
})
it('forwards explicit selection and trusted context, then removes caller listener', async () => {
  const owner = sender()
  const progress = { sourceRetirement: 'pending' }
  mocks.resume.mockResolvedValue(progress)
  await expect(
    handler('resumeOrcadLiveMigration')(
      { sender: owner },
      { ...selection, profileDirectory: '/evil', runtime: {} }
    )
  ).resolves.toBe(progress)
  expect(mocks.resume).toHaveBeenCalledWith('/trusted', context, selection, expect.any(AbortSignal))
  expect(owner.listenerCount('destroyed')).toBe(0)
})
it.each([
  {},
  { ...selection, mode: undefined },
  { ...selection, mode: 'auto' },
  { ...selection, selector: '' }
])('rejects invalid selection %j', async (value) => {
  const owner = sender()
  await expect(handler('resumeOrcadLiveMigration')({ sender: owner }, value)).rejects.toThrow()
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(owner.listenerCount('destroyed')).toBe(0)
})
it('refuses absent context without service execution', async () => {
  mocks.handle.mockClear()
  registerOrcadLiveMigrationHandlers(() => '/trusted')
  await expect(
    handler('resumeOrcadLiveMigration')({ sender: sender() }, selection)
  ).rejects.toThrow('unavailable')
  expect(mocks.resume).not.toHaveBeenCalled()
})
it.each([true, false])('aborts destroyed caller, initially destroyed=%s', async (destroyed) => {
  const owner = sender(destroyed)
  mocks.resume.mockImplementation(async (_profile, _context, _selection, signal: AbortSignal) => {
    owner.emit('destroyed')
    signal.throwIfAborted()
  })
  await expect(handler('resumeOrcadLiveMigration')({ sender: owner }, selection)).rejects.toThrow(
    'caller_destroyed'
  )
  expect(owner.listenerCount('destroyed')).toBe(0)
  if (destroyed) {
    expect(mocks.resume).not.toHaveBeenCalled()
  }
})
it('uses bounded timeout and cleans listeners on service failure', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  const owner = sender()
  mocks.resume.mockRejectedValue(new Error('mutation disabled'))
  await expect(handler('resumeOrcadLiveMigration')({ sender: owner }, selection)).rejects.toThrow(
    'mutation disabled'
  )
  expect(timeout).toHaveBeenCalledWith(120_000)
  expect(owner.listenerCount('destroyed')).toBe(0)
  timeout.mockRestore()
})

it('starts with only selectors and main-owned context, stripping injected transfer evidence', async () => {
  const owner = sender()
  const progress = { sourceRetirement: 'pending' }
  mocks.start.mockResolvedValue(progress)
  await expect(
    handler('startOrcadLiveMigration')(
      { sender: owner },
      {
        selector: ' host ',
        targetId: ' target ',
        migrationId: 'injected',
        identities: ['secret'],
        profileDirectory: '/evil',
        runtime: {}
      }
    )
  ).resolves.toBe(progress)
  expect(mocks.start).toHaveBeenCalledWith(
    '/trusted',
    context,
    { selector: 'host', targetId: 'target' },
    expect.any(AbortSignal)
  )
  expect(owner.listenerCount('destroyed')).toBe(0)
  expect(mocks.resume).not.toHaveBeenCalled()
})

it.each([
  {},
  { selector: 'host' },
  { selector: '', targetId: 'target' },
  { selector: 'host', targetId: ' ' }
])('rejects invalid start selection %j', async (value) => {
  const owner = sender()
  await expect(handler('startOrcadLiveMigration')({ sender: owner }, value)).rejects.toThrow()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(owner.listenerCount('destroyed')).toBe(0)
})

it.each([true, false])(
  'cancels start for destroyed caller, initially destroyed=%s',
  async (destroyed) => {
    const owner = sender(destroyed)
    mocks.start.mockImplementation(async (_profile, _context, _args, signal: AbortSignal) => {
      owner.emit('destroyed')
      signal.throwIfAborted()
    })
    await expect(
      handler('startOrcadLiveMigration')(
        { sender: owner },
        { selector: 'host', targetId: 'target' }
      )
    ).rejects.toThrow('caller_destroyed')
    expect(owner.listenerCount('destroyed')).toBe(0)
    if (destroyed) {
      expect(mocks.start).not.toHaveBeenCalled()
    }
  }
)

it('refuses start without runtime context', async () => {
  mocks.handle.mockClear()
  registerOrcadLiveMigrationHandlers(() => '/trusted')
  await expect(
    handler('startOrcadLiveMigration')(
      { sender: sender() },
      { selector: 'host', targetId: 'target' }
    )
  ).rejects.toThrow('unavailable')
  expect(mocks.start).not.toHaveBeenCalled()
})
