import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon-pty-router'
import { TerminalSessionOwnerUnverifiedError } from '../../../protocol/daemon-errors'

describe('DaemonPtyRouter session listing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists sessions when another session exits while the listing is in flight', async () => {
    const current = createAdapter('current', ['shell-a', 'shell-b'])
    const router = new DaemonPtyRouter({ current, legacy: [] })
    await router.discoverLegacySessions()
    const list = vi.mocked(current.listProcesses)
    list.mockImplementationOnce(async () => {
      current.emitExit('shell-a', 0)
      return [
        { id: 'shell-a', cwd: '', title: '' },
        { id: 'shell-b', cwd: '', title: '' }
      ]
    })
    list.mockImplementationOnce(async () => [{ id: 'shell-b', cwd: '', title: '' }])

    const listed = await router.listProcesses()

    expect(listed.map((session) => session.id)).toEqual(['shell-b'])
  })

  it('gives up within one listing budget when a re-read after churn never answers', async () => {
    vi.useFakeTimers()
    const current = createAdapter('current', ['shell-a'])
    const router = new DaemonPtyRouter({ current, legacy: [] })
    await router.discoverLegacySessions()
    const list = vi.mocked(current.listProcesses)
    list.mockImplementationOnce(async () => {
      current.emitExit('shell-a', 0)
      return [{ id: 'shell-a', cwd: '', title: '' }]
    })
    list.mockImplementation(() => new Promise(() => {}))

    const settled = router.listProcesses().then(
      () => 'listed',
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(2_500)

    expect(await settled).toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
  })
})
