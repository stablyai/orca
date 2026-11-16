// Shared-worker files keep module state, so a chat host one file registers would answer the next file's lookups.
import { afterAll } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-registry'

afterAll(() => {
  setStructuredAgentSessionHost(null)
})
