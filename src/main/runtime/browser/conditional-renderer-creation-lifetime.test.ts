import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ uuid: vi.fn(), on: vi.fn(), remove: vi.fn() }))
vi.mock('node:crypto', () => ({ randomUUID: mocks.uuid }))
vi.mock('electron', () => ({ ipcMain: { on: mocks.on, removeListener: mocks.remove } }))

let root: string
beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.uuid.mockReturnValue('request')
  root = await mkdtemp(join(tmpdir(), 'orca-renderer-lifetime-'))
  vi.useFakeTimers()
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const { createBrowserTabInRenderer } = await import('./browser-tab-renderer-create')
  const { tryAcquireConditionalWorktreeRemoval } =
    await import('../../ipc/conditional-worktree-removal-lease')
  const sender = { send: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this helper accesses only the mock window's webContents identity and send method.
  const host = { getAuthoritativeWindow: () => ({ webContents: sender }) } as unknown as Pick<
    RuntimeBrowserCommandHost,
    'getAuthoritativeWindow'
  >
  const run = () =>
    createBrowserTabInRenderer(host, 'about:blank', `repo::${root}`, undefined, undefined)
  const assertIdle = () => {
    const lease = tryAcquireConditionalWorktreeRemoval(root)
    expect(lease.kind).toBe('acquired')
    if (lease.kind === 'acquired') {
      lease.release()
    }
  }
  return { host, run, sender, assertIdle, busy: () => tryAcquireConditionalWorktreeRemoval(root) }
}

it.each(['window', 'uuid', 'listener'] as const)(
  'releases a pre-send %s failure without changing its error',
  async (stage) => {
    const f = await fixture()
    const failure = new Error(`failed ${stage}`)
    if (stage === 'window') {
      f.host.getAuthoritativeWindow = () => {
        throw failure
      }
    }
    if (stage === 'uuid') {
      mocks.uuid.mockImplementation(() => {
        throw failure
      })
    }
    if (stage === 'listener') {
      mocks.on.mockImplementation(() => {
        throw failure
      })
    }
    await expect(f.run()).rejects.toBe(failure)
    expect(f.sender.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    f.assertIdle()
  }
)

it('keeps an uncertain send exception admitted while cleaning its timer and listener', async () => {
  const f = await fixture()
  const failure = new Error('send failed')
  f.sender.send.mockImplementation(() => {
    throw failure
  })
  await expect(f.run()).rejects.toBe(failure)
  expect(vi.getTimerCount()).toBe(0)
  expect(mocks.remove).toHaveBeenCalledWith('browser:tabCreateReply', expect.any(Function))
  expect(f.busy()).toEqual({ kind: 'busy' })
})

it('keeps a sent request admitted after its ordinary timeout response', async () => {
  const f = await fixture()
  const result = f.run().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(10000)
  expect(await result).toEqual(new Error('Tab creation timed out'))
  expect(vi.getTimerCount()).toBe(0)
  expect(mocks.remove).toHaveBeenCalledWith('browser:tabCreateReply', expect.any(Function))
  expect(f.busy()).toEqual({ kind: 'busy' })
})

it.each([false, true])('releases a matching reply, error=%s', async (failed) => {
  const f = await fixture()
  const result = f.run().catch((error: unknown) => error)
  const handler = mocks.on.mock.calls[0]?.[1]
  if (typeof handler !== 'function') {
    throw new Error('Expected reply handler')
  }
  handler(
    { sender: f.sender },
    { requestId: 'request', ...(failed ? { error: 'client error' } : { browserPageId: 'page' }) }
  )
  expect(await result).toEqual(failed ? new Error('client error') : { browserPageId: 'page' })
  expect(vi.getTimerCount()).toBe(0)
  f.assertIdle()
})
