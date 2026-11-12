import { afterEach, describe, expect, it, vi } from 'vitest'

const initDaemonPtyProvider = vi.hoisted(() => vi.fn())
vi.mock('../../daemon/providers/lifecycle/daemon-provider-init', () => ({ initDaemonPtyProvider }))

import { startOrcadDaemon } from './orcad-daemon-supervision'
import { OrcadTerminalsNotDurableError } from '../serve-startup/orcad-serve-supervision'
import { resolveOrcadExitCode } from '../serve-startup/orcad-exit-code'
import {
  ORCA_SERVE_SUPERVISED_ENV,
  ORCAD_EXIT_TERMINALS_NOT_DURABLE
} from '../../../shared/serve-supervised-terminal-durability'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[ORCA_SERVE_SUPERVISED_ENV]
})

describe('startOrcadDaemon', () => {
  it('refuses to serve a supervised host whose terminals would die with it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    initDaemonPtyProvider.mockRejectedValue(new Error('daemon health check rejected'))

    process.env[ORCA_SERVE_SUPERVISED_ENV] = '1'
    const supervised = startOrcadDaemon('linux')
    await expect(supervised).rejects.toBeInstanceOf(OrcadTerminalsNotDurableError)
    const error = await supervised.catch((caught: unknown) => caught)
    expect(resolveOrcadExitCode(error)).toBe(ORCAD_EXIT_TERMINALS_NOT_DURABLE)
    expect(String(error)).toContain('daemon health check rejected')
    expect(process.env[ORCA_SERVE_SUPERVISED_ENV]).toBeUndefined()

    await expect(startOrcadDaemon('linux')).resolves.toMatchObject({
      state: 'unavailable'
    })
  })
})
