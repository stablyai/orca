import type { InitializeResponse } from '../acp/generated/acp-protocol.generated'
import type { AcpScriptedAgent } from '../acp/acp-scripted-agent.test-support'
import { PROVIDER_SESSION } from '../acp/acp-structured-adapter.test-support'

// Initialize capability subset captured from original @google/gemini-cli@0.65.0 with an empty home.
export const GEMINI_ACP_INITIALIZE = {
  protocolVersion: 1,
  authMethods: [
    { id: 'oauth-personal', name: 'Log in with Google' },
    { id: 'gemini-api-key', name: 'Gemini API key' },
    { id: 'vertex-ai', name: 'Vertex AI' },
    { id: 'gateway', name: 'AI API Gateway' }
  ],
  agentInfo: { name: 'gemini-cli', title: 'Gemini CLI', version: '0.65.0' },
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true }
  }
} satisfies InitializeResponse

// Synthetic model IDs exercise the session-advertised catalog without pinning Gemini model names.
export const GEMINI_ACP_SESSION = {
  sessionId: PROVIDER_SESSION,
  modes: {
    currentModeId: 'default',
    availableModes: [{ id: 'default', name: 'Default' }]
  },
  models: {
    currentModelId: 'runtime-default',
    availableModels: [
      { modelId: 'runtime-default', name: 'Runtime default' },
      { modelId: 'runtime-alternate', name: 'Runtime alternate' }
    ]
  }
}

export const GEMINI_ACP_TOOL = {
  toolCallId: 'run_shell_command-1',
  status: 'pending' as const,
  title: 'printf fixture',
  kind: 'execute' as const,
  locations: [],
  content: []
}

export const GEMINI_ACP_PERMISSION = {
  sessionId: PROVIDER_SESSION,
  toolCall: GEMINI_ACP_TOOL,
  options: [
    { optionId: 'proceed_always', name: 'Allow for this session', kind: 'allow_always' },
    { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'cancel', name: 'Reject', kind: 'reject_once' }
  ]
}

export function scriptGeminiAcpSession(agent: AcpScriptedAgent): void {
  agent.on('session/new', (frame) => agent.reply(frame, GEMINI_ACP_SESSION))
  agent.on('session/load', (frame) => agent.reply(frame, GEMINI_ACP_SESSION))
  agent.on('session/set_model', (frame) => agent.reply(frame, {}))
  agent.on('session/set_config_option', (frame) => agent.fail(frame, -32601, 'Method not found'))
}
