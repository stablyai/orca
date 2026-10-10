import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeEnvironmentStatus } from '../ipc/runtime-environment-transport-routing'
import {
  supportsSkillRuntimeCancellation,
  supportsSkillRuntimeInstall,
  supportsSkillRuntimeManagement
} from './skill-runtime-capability'

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  getRuntimeEnvironmentStatus: vi.fn()
}))

const status = vi.mocked(getRuntimeEnvironmentStatus)

beforeEach(() => {
  status.mockReset()
})

describe('skill runtime capability admission', () => {
  it('admits install and management independently', async () => {
    status.mockResolvedValue({
      ok: true,
      result: {
        capabilities: ['skills.install.v1'],
        runtimeId: 'runtime_1'
      }
    } as never)

    await expect(supportsSkillRuntimeInstall('/state', 'environment_1')).resolves.toBe(true)
    await expect(supportsSkillRuntimeManagement('/state', 'environment_1')).resolves.toBe(false)
  })

  it('admits cancellation only when the host advertises it', async () => {
    status
      .mockResolvedValueOnce({
        ok: true,
        result: { capabilities: ['skills.install.v1'], runtimeId: 'runtime_1' }
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        result: { capabilities: ['skills.install-cancel.v1'], runtimeId: 'runtime_1' }
      } as never)

    await expect(supportsSkillRuntimeCancellation('/state', 'environment_1')).resolves.toBe(false)
    await expect(supportsSkillRuntimeCancellation('/state', 'environment_1')).resolves.toBe(true)
  })

  it('fails closed for unavailable and capability-omitting hosts', async () => {
    status
      .mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'offline' } } as never)
      .mockResolvedValueOnce({
        ok: true,
        result: { runtimeId: 'runtime_1', capabilities: [] }
      } as never)

    await expect(supportsSkillRuntimeInstall('/state', 'environment_1')).resolves.toBe(false)
    await expect(supportsSkillRuntimeInstall('/state', 'environment_1')).resolves.toBe(false)
  })
})
