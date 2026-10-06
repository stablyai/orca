import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const UUID = '11111111-1111-4111-8111-111111111111'
const LOCAL = JSON.stringify({ kind: 'local', hostId: 'local' })
const SSH = JSON.stringify({ kind: 'ssh', targetId: 'ssh-1' })

function fixture() {
  const runtime = new OrcaRuntimeService()
  const listProcesses = vi.fn().mockResolvedValue([])
  const probePtyLiveness = vi.fn().mockResolvedValue(false)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses,
    probePtyLiveness
  })
  return { runtime, listProcesses, probePtyLiveness }
}

describe('owning provider proof for a missing process incarnation', () => {
  it.each([
    ['local-pty', LOCAL, null],
    ['local-pty', JSON.stringify({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }), null],
    ['ssh:ssh-1@@pty-1', SSH, 'ssh-1']
  ])('requires a fresh negative owning-provider probe for %s', async (ptyId, scope, target) => {
    const { runtime, listProcesses, probePtyLiveness } = fixture()
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(`${ptyId}:${UUID}`, scope)
    ).resolves.toBe('exited')
    expect(probePtyLiveness).toHaveBeenCalledWith(ptyId)
    expect(listProcesses).toHaveBeenCalledTimes(2)
    expect(listProcesses).toHaveBeenLastCalledWith(target)
  })

  it.each([true, null])('does not certify death from a %s probe', async (verdict) => {
    const { runtime, probePtyLiveness } = fixture()
    probePtyLiveness.mockResolvedValue(verdict)
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(`local-pty:${UUID}`, LOCAL)
    ).resolves.toBe('unverifiable')
  })

  it('keeps a failed owning-provider probe unverifiable', async () => {
    const { runtime, probePtyLiveness } = fixture()
    probePtyLiveness.mockRejectedValue(new Error('host unavailable'))
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(`local-pty:${UUID}`, LOCAL)
    ).resolves.toBe('unverifiable')
  })

  it.each([
    ['local-pty:legacy:incarnation', LOCAL],
    [`ssh:ssh-other@@pty-1:${UUID}`, SSH],
    [`ssh:ssh-1@@pty-1:${UUID}`, LOCAL],
    [`local-pty:${UUID}`, SSH],
    [`local-pty: ${UUID}`, LOCAL]
  ])('does not probe an ambiguous or wrong-host identity %s', async (incarnation, scope) => {
    const { runtime, probePtyLiveness } = fixture()
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(incarnation, scope)
    ).resolves.toBe('unverifiable')
    expect(probePtyLiveness).not.toHaveBeenCalled()
  })

  it.each([UUID, '22222222-2222-4222-8222-222222222222', undefined])(
    'rejects stale negative proof when the PTY reappears as %s',
    async (incarnationId) => {
      const { runtime, listProcesses } = fixture()
      listProcesses
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'local-pty', incarnationId, cwd: '', title: 'worker' }])
      await expect(
        runtime.inspectTerminalProcessIncarnationLiveness(`local-pty:${UUID}`, LOCAL)
      ).resolves.toBe(incarnationId === UUID ? 'live' : 'unverifiable')
    }
  )

  it('does not certify death when the post-probe inventory fails', async () => {
    const { runtime, listProcesses } = fixture()
    listProcesses.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('reconnecting'))
    await expect(
      runtime.inspectTerminalProcessIncarnationLiveness(`local-pty:${UUID}`, LOCAL)
    ).resolves.toBe('unverifiable')
  })
})
