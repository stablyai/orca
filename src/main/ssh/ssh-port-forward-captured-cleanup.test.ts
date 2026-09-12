import { expect, it, vi } from 'vitest'
import { SshPortForwardManager } from './ssh-port-forward'
import type { SshConnection } from './ssh-connection'
import type { PortForwardStartOptions, StartedPortForward } from './ssh-port-forward-provider'

function fixture() {
  const started: (StartedPortForward & { options: PortForwardStartOptions })[] = []
  const onForwardClosed = vi.fn()
  const manager = new SshPortForwardManager({ onForwardClosed }, [
    {
      canHandle: () => true,
      start: async (_conn, options) => {
        const forward = {
          entry: { ...options },
          options,
          close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
          dispose: vi.fn()
        }
        started.push(forward)
        return forward
      }
    }
  ])
  const conn = {} as SshConnection
  const add = (target = 'target') => manager.addForward(target, conn, 3000, 'localhost', 8080)
  return { manager, started, onForwardClosed, conn, add }
}

it('retires only the captured cohort and shares exact retry completion', async () => {
  const f = fixture()
  await f.add()
  const cleanup = f.manager.captureForwardCleanup('target')
  expect(cleanup.assertRemoved).toThrow('ssh_port_forward_cleanup_unconfirmed')
  const later = await f.add()
  const unrelated = await f.add('other')
  await Promise.all([cleanup.removeAndWait(), cleanup.removeAndWait()])
  cleanup.assertRemoved()
  expect(f.manager.listForwards()).toEqual([later, unrelated])
  expect(f.started[0].close).toHaveBeenCalledTimes(1)
  expect(f.started[1].close).not.toHaveBeenCalled()
  expect(f.onForwardClosed).not.toHaveBeenCalled()
})

it('preserves same-ID replacements and suppresses stale close notifications', async () => {
  const f = fixture()
  const entry = await f.add()
  const cleanup = f.manager.captureForwardCleanup('target')
  const replacement = await f.manager.updateForward(entry.id, f.conn, 3001, 'localhost', 8081)
  await cleanup.removeAndWait()
  f.started[0].options.onUnexpectedClose?.(entry, { kind: 'unexpected-exit' })
  cleanup.assertRemoved()
  expect(f.manager.listForwards()).toEqual([replacement])
  expect(f.started[0].close).toHaveBeenCalledTimes(1)
  expect(f.started[1].close).not.toHaveBeenCalled()
  expect(f.onForwardClosed).not.toHaveBeenCalled()
})

it('awaits a previously removed selected listener without touching its replacement', async () => {
  const f = fixture()
  const entry = await f.add()
  let finish!: () => void
  vi.mocked(f.started[0].close).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const cleanup = f.manager.captureForwardCleanup('target')
  const updating = f.manager.updateForward(entry.id, f.conn, 3001, 'localhost', 8081)
  let completed = false
  const cleaning = cleanup.removeAndWait().then(() => {
    completed = true
  })
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(cleanup.assertRemoved).toThrow()
  finish()
  const replacement = await updating
  await cleaning
  cleanup.assertRemoved()
  expect(f.manager.listForwards()).toEqual([replacement])
  expect(f.started[0].close).toHaveBeenCalledTimes(1)
  expect(f.started[1].close).not.toHaveBeenCalled()
})

it('keeps failed cleanup unconfirmed and retries only the selected instance', async () => {
  const f = fixture()
  await f.add()
  vi.mocked(f.started[0].close).mockRejectedValueOnce(new Error('close failed'))
  const cleanup = f.manager.captureForwardCleanup('target')
  await expect(cleanup.removeAndWait()).rejects.toThrow('close failed')
  expect(cleanup.assertRemoved).toThrow()
  const later = await f.add()
  await cleanup.removeAndWait()
  cleanup.assertRemoved()
  expect(f.manager.listForwards()).toEqual([later])
  expect(f.started[0].close).toHaveBeenCalledTimes(2)
})
