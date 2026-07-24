import { describe, expect, it, vi } from 'vitest'
import { SshPtyPersistenceRevive } from './ssh-pty-persistence-revive'

type MockMultiplexer = { request: ReturnType<typeof vi.fn> }

function createSubject(): { mux: MockMultiplexer; subject: SshPtyPersistenceRevive } {
  const mux = { request: vi.fn().mockResolvedValue(undefined) }
  return {
    mux,
    subject: new SshPtyPersistenceRevive(
      mux as never,
      (id) => `relay:${id}`,
      (id) => `app:${id}`
    )
  }
}

describe('SshPtyPersistenceRevive', () => {
  it('uses the v2 protocol and maps relay ids back to application ids', async () => {
    const { mux, subject } = createSubject()
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'pty.getCapabilities') {
        return { ptyPersistenceEnvelopeVersion: 2, ptyReviveOutcomeVersion: 1 }
      }
      if (method === 'pty.serialize') {
        return 'v2-state'
      }
      if (method === 'pty.revive') {
        return {
          outcomeVersion: 1,
          revived: [
            { id: 'pty-1', disposition: 'replacement-spawned', incarnationId: 'incarnation-1' }
          ],
          lost: [
            {
              id: 'pty-2',
              kind: 'ordinary-shell',
              reason: 'process-not-running',
              pid: 42,
              cols: 80,
              rows: 24,
              cwd: '/repo'
            }
          ],
          diagnostics: []
        }
      }
      return undefined
    })

    await expect(subject.serialize(['pty-1'], { formatVersion: 2 })).resolves.toBe('v2-state')
    await expect(subject.revive('v2-state', { formatVersion: 2 })).resolves.toMatchObject({
      mode: 'typed',
      outcome: { revived: [{ id: 'app:pty-1' }], lost: [{ id: 'app:pty-2' }] }
    })
    expect(mux.request).toHaveBeenCalledWith('pty.serialize', {
      ids: ['relay:pty-1'],
      formatVersion: 2
    })
    expect(mux.request).toHaveBeenCalledWith('pty.revive', { state: 'v2-state', formatVersion: 2 })
  })

  it('uses legacy revive only when capability discovery is unavailable', async () => {
    const { mux, subject } = createSubject()
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'pty.getCapabilities') {
        throw Object.assign(new Error('method not found'), { code: -32601 })
      }
      return undefined
    })

    await expect(subject.revive('legacy-state', { formatVersion: 2 })).resolves.toEqual({
      mode: 'legacy',
      diagnosticCode: 'pty-revive-outcome-unavailable'
    })
    expect(mux.request).toHaveBeenCalledWith('pty.revive', { state: 'legacy-state' })
  })

  it('fails closed when a relay claiming v2 returns a malformed outcome', async () => {
    const { mux, subject } = createSubject()
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'pty.getCapabilities') {
        return { ptyPersistenceEnvelopeVersion: 2, ptyReviveOutcomeVersion: 1 }
      }
      if (method === 'pty.revive') {
        return { outcomeVersion: 1, revived: [], lost: [] }
      }
      return undefined
    })

    await expect(subject.revive('v2-state', { formatVersion: 2 })).rejects.toThrow(
      'PTY revive outcome'
    )
    expect(mux.request.mock.calls.map((call) => call[0])).toEqual([
      'pty.getCapabilities',
      'pty.revive'
    ])
  })

  it('keeps the existing legacy wire until a caller explicitly requests v2', async () => {
    const { mux, subject } = createSubject()

    await expect(subject.serialize(['pty-1'])).resolves.toBeUndefined()
    await expect(subject.revive('legacy-state')).resolves.toEqual({
      mode: 'legacy',
      diagnosticCode: 'pty-revive-outcome-unavailable'
    })
    expect(mux.request).toHaveBeenCalledWith('pty.serialize', { ids: ['relay:pty-1'] })
    expect(mux.request).toHaveBeenCalledWith('pty.revive', { state: 'legacy-state' })
    expect(mux.request).not.toHaveBeenCalledWith('pty.getCapabilities')
  })
})
