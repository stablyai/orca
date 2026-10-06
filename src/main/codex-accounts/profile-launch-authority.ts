// Ask the provider for effective cwd/policy routing; local config alone cannot establish it.
import { CODEX_PROFILE_FILE_AUTH_ARGS } from './profile-config-authority'
import type { AgentProfileSnapshot } from '../../shared/agent-launch-profile'
import {
  AgentProfilePreparationError,
  sanitizedProfilePreparationError
} from '../agent-profiles/preparation-error'
import { runCodexAppServerSession } from '../codex/codex-app-server-session'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'

export const CODEX_PROFILE_ROUTING_ENV = [
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'CHATGPT_BASE_URL',
  'CODEX_CHATGPT_BASE_URL',
  'CODEX_ACCESS_TOKEN',
  'CODEX_AUTH_TOKEN',
  'OPENAI_ORGANIZATION',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID'
] as const
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
export function assertCodexProfileRoutingConfiguration(config: Record<string, unknown>): void {
  const allowed: Record<string, string> = {
    model_provider: 'openai',
    cli_auth_credentials_store: 'file',
    forced_login_method: 'chatgpt'
  }
  for (const [key, expected] of Object.entries(allowed)) {
    if (config[key] != null && config[key] !== expected) {
      throw new AgentProfilePreparationError('codex_config')
    }
  }
  if (
    [
      'openai_base_url',
      'chatgpt_base_url',
      'profile',
      'experimental_realtime_ws_base_url',
      'forced_chatgpt_workspace_id'
    ].some((key) => config[key] != null) ||
    (config.model_providers != null &&
      (!record(config.model_providers) || 'openai' in config.model_providers))
  ) {
    throw new AgentProfilePreparationError('codex_config')
  }
}
function assertRequirements(value: unknown): void {
  if (!record(value) || !('requirements' in value)) {
    throw new AgentProfilePreparationError('codex_policy')
  }
  if (value.requirements === null) {
    return
  }
  if (!record(value.requirements)) {
    throw new AgentProfilePreparationError('codex_policy')
  }
  const requirements = value.requirements
  assertCodexProfileRoutingConfiguration({
    model_provider: requirements.modelProvider,
    model_providers: requirements.modelProviders,
    cli_auth_credentials_store: requirements.cliAuthCredentialsStore,
    chatgpt_base_url: requirements.chatgptBaseUrl,
    forced_chatgpt_workspace_id:
      requirements.forcedChatgptWorkspaceId ?? requirements.forced_chatgpt_workspace_id
  })
  if (
    requirements.allowedLoginMethods != null &&
    (!Array.isArray(requirements.allowedLoginMethods) ||
      !requirements.allowedLoginMethods.includes('chatgpt'))
  ) {
    throw new AgentProfilePreparationError('codex_config')
  }
}
export async function observeCodexProfileLaunchAuthority(
  input: { snapshot: AgentProfileSnapshot; cwd: string; env: NodeJS.ProcessEnv },
  runSession: typeof runCodexAppServerSession = runCodexAppServerSession
): Promise<void> {
  const { snapshot, cwd, env } = input
  if (snapshot.agent !== 'codex' || snapshot.binding.kind !== 'managed') {
    return
  }
  if (CODEX_PROFILE_ROUTING_ENV.some((key) => env[key] !== undefined)) {
    throw new AgentProfilePreparationError('codex_config')
  }
  if (snapshot.identity.kind !== 'verified') {
    throw new AgentProfilePreparationError('codex_policy')
  }
  const expectedEmail = snapshot.identity.displayName
  const definedEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      definedEnv[key] = value
    }
  }
  try {
    await runSession(
      {
        command: snapshot.executable,
        cliPath: snapshot.executable,
        cwd,
        args: [...CODEX_PROFILE_FILE_AUTH_ARGS, ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
        env: { ...definedEnv, CODEX_HOME: snapshot.resolvedHome },
        envToDelete: ['OPENAI_API_KEY', 'CODEX_API_KEY', ...CODEX_PROFILE_ROUTING_ENV],
        timeoutMs: 8000,
        maxOutputBytes: 1024 * 1024
      },
      async (rpc) => {
        const read = await rpc.request('config/read', { cwd, includeLayers: true })
        if (
          !record(read) ||
          !record(read.config) ||
          !record(read.origins) ||
          !Array.isArray(read.layers) ||
          !('model_provider' in read.config)
        ) {
          throw new AgentProfilePreparationError('codex_policy')
        }
        // The provider materializes its built-in URL without an origin. Explicit sources
        // still pass through the stricter layer/policy checks below, even for this exact URL.
        const effectiveConfig =
          read.config.chatgpt_base_url === 'https://chatgpt.com/backend-api/' &&
          !Object.hasOwn(read.origins, 'chatgpt_base_url')
            ? { ...read.config, chatgpt_base_url: undefined }
            : read.config
        assertCodexProfileRoutingConfiguration(effectiveConfig)
        if (read.config.cli_auth_credentials_store !== 'file') {
          throw new AgentProfilePreparationError('codex_policy')
        }
        // The probe pins file storage before startup; inspect original active layers so the pin cannot hide a conflict.
        for (const layer of read.layers) {
          if (!record(layer) || !record(layer.name) || !record(layer.config)) {
            throw new AgentProfilePreparationError('codex_policy')
          }
          if (layer.disabledReason == null) {
            assertCodexProfileRoutingConfiguration(layer.config)
          }
        }
        assertRequirements(await rpc.request('configRequirements/read', {}))
        const active = await rpc.request('account/read', { refreshToken: false })
        if (
          !record(active) ||
          active.requiresOpenaiAuth !== true ||
          !record(active.account) ||
          active.account.type !== 'chatgpt' ||
          active.account.email !== expectedEmail
        ) {
          throw new AgentProfilePreparationError('codex_policy')
        }
      }
    )
  } catch (error) {
    throw sanitizedProfilePreparationError(
      error,
      new AgentProfilePreparationError('codex_policy').message
    )
  }
}
