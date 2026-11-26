import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AcpHostBackendInput } from '../acp/launch/acp-launch-contract'
import { AcpAuthRequiredError } from '../acp/transport/acp-errors'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { antigravityAgySignIn } from './antigravity-chat-route'
import { forgetAntigravityHostAcpChecks } from './antigravity-host-acp'

vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: async () => 'absent' }))

// agy 1.5.17 without a Google login: session/list answers only when AGY_LLM_GATEWAY_URL is set.
vi.mock('./antigravity-acp-runtime-probe', () => ({
  initializeAntigravityAcp: async (
    launch: (folder: string) => AcpHostBackendInput,
    _timeoutMs: number,
    _signal: AbortSignal | undefined,
    check: (connection: unknown, initialized: unknown, folder: string) => Promise<void>
  ) => {
    const folder = tmpdir()
    const env = resolveProviderChildEnv(launch(folder), {})
    const initialized = {
      protocolVersion: 1,
      agentInfo: { name: 'Antigravity ACP Server', version: '1.5.17' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {} },
        _meta: { antigravity: { systemPrompt: { append: true } } }
      }
    }
    const listSessions = async () => {
      if (!env.AGY_LLM_GATEWAY_URL) {
        throw new AcpAuthRequiredError('Authentication required')
      }
      return { sessions: [] }
    }
    await check({ listSessions }, initialized, folder)
    return initialized
  }
}))

afterEach(() => forgetAntigravityHostAcpChecks())

const gatewayInput = (antigravityChatAuth: AntigravityChatAuthConfig): AcpHostBackendInput => ({
  command: process.execPath,
  homePath: tmpdir(),
  env: { AGY_LLM_GATEWAY_URL: 'http://127.0.0.1:1' },
  envToDelete: [],
  stateDirectory: tmpdir(),
  settings: { antigravityChatAuth },
  startsProgram: true
})

it('reads agy as signed in through a gateway without a Google login', async () => {
  expect(await antigravityAgySignIn(gatewayInput({ method: 'oauth-personal' }))).toBe('signedIn')
  const withoutGateway = { ...gatewayInput({ method: 'oauth-personal' }), env: {} }
  expect(await antigravityAgySignIn(withoutGateway)).toBe('signedOut')
  // Enterprise chats run on Orca's home, which drops the gateway, so they still need the login.
  const enterprise = gatewayInput({
    method: 'oauth-business',
    gcpProject: 'project',
    gcpLocation: 'global'
  })
  expect(await antigravityAgySignIn(enterprise)).toBe('signedOut')
})
