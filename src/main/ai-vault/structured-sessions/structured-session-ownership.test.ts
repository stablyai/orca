import { afterEach, expect, it } from 'vitest'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { assertLegacyAiVaultResumeCommandAllowed } from './structured-session-ownership'
import { installOwnership, PROVIDER_SESSION } from './structured-session-ownership.test-support'

// The host is process-wide: a shared test runner must not hand this partial one to the next file.
afterEach(() => setStructuredAgentSessionHost(null))

it.each([
  // The line Session History copies for a real-home Codex session.
  `cd '/repo' && env -u CODEX_HOME -u ORCA_CODEX_HOME codex 'resume' '${PROVIDER_SESSION}'`,
  `sudo -u dev codex resume ${PROVIDER_SESSION}`
])('refuses an owned resume behind launcher options: %s', async (command) => {
  installOwnership()

  await expect(
    assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined)
  ).rejects.toThrow('agent_session_conflict')
})
