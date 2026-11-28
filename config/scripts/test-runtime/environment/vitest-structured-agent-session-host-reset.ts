// Shared-worker files keep module state, so a chat host one file registers would answer the next file's lookups.
import { afterAll, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../../src/main/native-chat/agent-session-wire/host/structured-agent-session-registry'

afterAll(async () => {
  // A background import still settling could register a host after the clear.
  await vi.dynamicImportSettled()
  setStructuredAgentSessionHost(null)
})
