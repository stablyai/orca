import { describe, expect, it } from 'vitest'
import { runCommandForStdout } from './sync-command-output'

/** The PreTool policy scrubbed three secrets out of a copied environment and
 *  then had nowhere to hand it: the runner accepted no `env`, so the child
 *  inherited the full parent environment and the scrub did nothing.
 */
describe.skipIf(process.platform === 'win32')('a scrubbed environment reaches the child', () => {
  it('forwards the caller environment instead of inheriting the parent', () => {
    const original = process.env.ORCA_AGENT_LAUNCH_TOKEN
    process.env.ORCA_AGENT_LAUNCH_TOKEN = 'launch-token-should-not-leak'
    const env = { ...process.env }
    delete env.ORCA_AGENT_LAUNCH_TOKEN
    try {
      const seen = runCommandForStdout({
        program: '/bin/sh',
        args: ['-c', 'printf %s "${ORCA_AGENT_LAUNCH_TOKEN:-ABSENT}"'],
        env
      })
      expect(seen.trim()).toBe('ABSENT')
    } finally {
      // Restore rather than delete: the runner may have supplied this, and
      // clearing it would change shared state for later tests in this worker.
      if (original === undefined) {
        delete process.env.ORCA_AGENT_LAUNCH_TOKEN
      } else {
        process.env.ORCA_AGENT_LAUNCH_TOKEN = original
      }
    }
  })

  it('still inherits when no environment is supplied', () => {
    const original = process.env.ORCA_SYNC_ENV_PROBE
    process.env.ORCA_SYNC_ENV_PROBE = 'inherited'
    try {
      const seen = runCommandForStdout({
        program: '/bin/sh',
        args: ['-c', 'printf %s "${ORCA_SYNC_ENV_PROBE:-ABSENT}"']
      })
      expect(seen.trim()).toBe('inherited')
    } finally {
      if (original === undefined) {
        delete process.env.ORCA_SYNC_ENV_PROBE
      } else {
        process.env.ORCA_SYNC_ENV_PROBE = original
      }
    }
  })
})
