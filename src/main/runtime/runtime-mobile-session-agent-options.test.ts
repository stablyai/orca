import { beforeEach, describe, expect, it, vi } from 'vitest'
const detection = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn() }))
vi.mock('../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detection.local,
  detectRemoteAgents: detection.remote
}))
import { loadRuntimeMobileSessionAgentOptions } from './runtime-mobile-session-agent-options'

beforeEach(() => {
  vi.resetAllMocks()
  detection.local.mockResolvedValue(['codex', 'claude', 'amp', 'unknown'])
  detection.remote.mockResolvedValue(['codex', 'claude', 'amp'])
})
describe('session agent detection on the execution owner', () => {
  it.each([null, 'ssh-target'])(
    'uses resolved route %s and existing disabled/preference ordering',
    async (connection) => {
      expect(
        await loadRuntimeMobileSessionAgentOptions(connection, {
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['amp']
        })
      ).toEqual(['codex', 'claude'])
      if (connection) {
        expect(detection.remote).toHaveBeenCalledWith({ connectionId: connection })
        expect(detection.local).not.toHaveBeenCalled()
      } else {
        expect(detection.remote).not.toHaveBeenCalled()
        expect(detection.local).toHaveBeenCalledOnce()
      }
    }
  )
  it('never substitutes local detection for an unreachable SSH host', async () => {
    detection.remote.mockRejectedValue(new Error('offline'))
    await expect(loadRuntimeMobileSessionAgentOptions('ssh-target', {})).rejects.toThrow('offline')
    expect(detection.local).not.toHaveBeenCalled()
  })
})
