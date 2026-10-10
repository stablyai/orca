import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { StructuredAgentRuntimeRegistration } from '../runtime/structured-agent-runtime-registrations'
import { resolveStructuredCursorAccountHomePath } from '../runtime/structured-agent-account-home'
import { createCursorModelCatalogProbe } from './cursor-model-catalog-probe'
import { listCursorSdkModels } from './cursor-sdk-connection'
import { CURSOR_STRUCTURED_AGENT } from './cursor-structured-agent-definition'
import { supportsCursorStructuredLocation } from './cursor-structured-location-support'
import { CursorStructuredSessionAdapter } from './cursor-structured-session-adapter'

export const CURSOR_RUNTIME_REGISTRATION: StructuredAgentRuntimeRegistration = {
  definition: CURSOR_STRUCTURED_AGENT,
  modelCatalog: ({ deps }) => ({
    kind: 'probe',
    // A new structured Cursor chat runs the listed default unless the user picks another.
    listingNamesConfiguredModel: true,
    probe: createCursorModelCatalogProbe({ resolveApiKey: deps.resolveCursorApiKey })
  }),
  supportsLocation: supportsCursorStructuredLocation,
  resolveAccountHome: async () =>
    agentSessionAccountHome(CURSOR_STRUCTURED_AGENT, resolveStructuredCursorAccountHomePath()),
  createAdapter: (context) => {
    const { deps } = context
    return new CursorStructuredSessionAdapter({
      hostId: deps.hostId,
      stateDirectory: deps.stateDirectory,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      ...(deps.resolveCursorApiKey ? { resolveApiKey: deps.resolveCursorApiKey } : {}),
      listModels: (apiKey) => listCursorSdkModels({ apiKey }),
      resolveToolGate: () => {
        const bypass = deps.resolveAgentFullAccess?.('cursor') ?? false
        return { sandbox: !bypass, autoReview: !bypass }
      },
      ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
      onEvent: (event) => {
        if (event.type === 'ended') {
          context.deliverLifecycle(event)
        }
      }
    })
  }
}
