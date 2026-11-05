import { GROK_TEXT_TASK_ENV } from '../grok/grok-text-task'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/agent-session/environment/structured-session-child-env'
import { z } from 'zod'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type {
  RequestPermissionRequest,
  RequestPermissionResponse
} from './generated/acp-protocol.generated'

const envelope = z.looseObject({ sessionId: z.string() })

export function denyAcpTextTaskPermission(
  request: RequestPermissionRequest
): RequestPermissionResponse {
  const denied = request.options.find((option) => option.kind === 'reject_once')
  return {
    outcome: denied ? { outcome: 'selected', optionId: denied.optionId } : { outcome: 'cancelled' }
  }
}

export function acpTextTaskCompletion(
  dialect: AcpLaunchSpec['dialect'],
  sessionId: string,
  promptId: string,
  method: string,
  params: unknown
): { stopReason: string } | undefined {
  if (!sessionId || envelope.safeParse(params).data?.sessionId !== sessionId) {
    return undefined
  }
  const completion = dialect.textTaskCompletion?.(method, params)
  if (completion?.promptId === promptId) {
    return completion
  }
  const mapped = dialect.notification?.(method, params, Date.now())
  return mapped?.disposition === 'map' && mapped.turn === promptId && !mapped.replay && mapped.end
    ? mapped.end
    : undefined
}

export const TASK_ENV_TO_DELETE = [
  ...STRUCTURED_CHILD_ENV_TO_DELETE,
  'ORCA_AGENT_SESSION_ID',
  'ORCA_AGENT_SESSION_SPAWN_TOKEN',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_STRUCTURED_SESSION',
  'ORCA_CHAT_SCRATCH_DIR',
  'ORCA_CHAT_VISUALS_DIR'
]

export async function cleanupAcpTextTaskProtocol(
  work: () => Promise<unknown>,
  logger: AcpStructuredSessionAdapterDeps['logger']
): Promise<void> {
  try {
    await waitForPromiseWithSignal(work(), AbortSignal.timeout(2_000))
  } catch (error) {
    logger?.warn('Naming helper protocol cleanup failed', { scope: 'acp-text-task', error })
  }
}

export function acpTextTaskArgs(spec: AcpLaunchSpec): string[] {
  const args = spec.args({ fullAccess: false, pluginDir: null })
  if (spec.agent === 'grok') {
    args.splice(1, 0, '--no-leader')
  }
  return args
}

export function acpTextTaskEnv(
  agent: AcpLaunchSpec['agent'],
  env: Record<string, string>
): Record<string, string> {
  return agent === 'grok' ? { ...env, ...GROK_TEXT_TASK_ENV } : env
}
