import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'

export function structuredSessionProjectionStub<TStore>(store: TStore) {
  return {
    logger: recordingStructuredAgentSessionLogger().logger,
    store,
    agents: { capabilities: () => undefined }
  }
}
