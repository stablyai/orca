import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type { Store } from '../persistence'
import type { SshTarget } from '../../shared/ssh-types'
import { getActiveMultiplexer } from '../ipc/ssh'
import { listExternalAutomationManagers } from './external-manager'

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => {
      callback(new Error('not installed'))
      return { kill: vi.fn() }
    }
  )
)

vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return { ...actual, existsSync: vi.fn(() => false) }
})
vi.mock('../ipc/ssh', () => ({ getActiveMultiplexer: vi.fn() }))

beforeEach(() => {
  vi.mocked(getActiveMultiplexer).mockReset()
})

describe('remote external automation manager fanout', () => {
  it('bounds probes for a large target list and preserves provider order', async () => {
    const targets: SshTarget[] = Array.from({ length: 100 }, (_, index) => ({
      id: `ssh-${index}`,
      label: `Target ${index}`,
      host: `host-${index}`,
      port: 22,
      username: 'orca'
    }))
    let inFlight = 0
    let peak = 0
    const request = vi.fn(async (_method: string, input: { provider: string }) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return {
        jobs: [],
        hermesAvailable: input.provider === 'hermes',
        openclawAvailable: input.provider === 'openclaw'
      }
    })
    vi.mocked(getActiveMultiplexer).mockReturnValue({
      isDisposed: () => false,
      request
    } as never)

    const managers = await listExternalAutomationManagers({
      getSshTargets: () => targets
    } as Store)

    expect(peak).toBe(4)
    expect(request).toHaveBeenCalledTimes(200)
    expect(managers.map((manager) => manager.id)).toEqual(
      targets.flatMap((target) => [`hermes:ssh:${target.id}`, `openclaw:ssh:${target.id}`])
    )
  })
})
