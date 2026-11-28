/** ZCode's provider-handle namespace: nativeId is the `sess_...` id its `--resume` takes. */

import type { AgentSessionProviderHandleNamespace } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'

export const ZCODE_STRUCTURED_HANDLE_NAMESPACE = {
  transport: 'zcode-stream-json',
  agent: 'zcode'
} as const satisfies AgentSessionProviderHandleNamespace
