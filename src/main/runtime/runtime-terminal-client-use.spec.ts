import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

export function registerRuntimeTerminalClientUseTests(): void {
  describe('readTerminalClientUse', () => {
    it('reads a terminal a client is viewing as used', () => {
      const runtime = new OrcaRuntimeService()
      runtime.terminalRunFacts.recordSpawnCommit({ id: 'pty-1' })
      // What a client's terminal stream subscribe registers.
      const release = runtime.registerRemoteTerminalViewSubscriber('pty-1')
      expect(runtime.readTerminalClientUse('pty-1')).toBe('used')
      release()
      expect(runtime.readTerminalClientUse('pty-1')).toBe('unused')
    })
  })
}
