import { agentHookServer } from '../agent-hooks/server'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnResult } from '../providers/types'
import { ptyIncarnationById, ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import {
  OPENCODE_STARTUP_PROMPT_NONCE_ENV,
  OPENCODE_STARTUP_PROMPT_SHA256_ENV
} from '../../shared/opencode-startup-prompt'
import { OpenCodeStartupPromptClaims } from './opencode-startup-prompt-claims'

type OpenCodePromptRuntime = Pick<
  OrcaRuntimeService,
  | 'terminalRunFacts'
  | 'readOpenCodeStartupPromptOwner'
  | 'isPtyStopRequested'
  | 'subscribeToPtyExit'
>
const claims = new OpenCodeStartupPromptClaims()

export function reserveOpenCodeStartupPrompt(nonce: string, digest: string): boolean {
  agentHookServer.setStartupPromptClaimListener(
    (body) => claims.claim(body),
    () => claims.clear()
  )
  return claims.register(nonce, digest, () => 'pending')
}

export async function commitPtyWithOpenCodePromptIntent<Result extends PtySpawnResult>(
  context: {
    env?: Record<string, string>
    spawnEnv?: Record<string, string>
    deps: { runtime?: OpenCodePromptRuntime }
    result: PtySpawnResult
    provider: Pick<IPtyProvider, 'hasPty'>
    args: { connectionId?: string | null }
  },
  commit: () => Promise<Result>
): Promise<Result> {
  const options = {
    env: context.spawnEnv ?? context.env,
    runtime: context.deps.runtime,
    result: context.result,
    provider: context.provider,
    connectionId: context.args.connectionId
  }
  const facts = options.runtime?.terminalRunFacts
  facts?.reserveSpawnCommit(options.result)
  try {
    const result = await commit()
    bindOpenCodeStartupPromptOwner({ ...options, result })
    return result
  } catch (error) {
    const nonce = options.env?.[OPENCODE_STARTUP_PROMPT_NONCE_ENV]
    if (nonce) {
      claims.cancel(nonce)
    }
    throw error
  } finally {
    facts?.discardSpawnCommit(options.result)
  }
}

export function bindOpenCodeStartupPromptOwner(options: {
  env: Record<string, string> | undefined
  result: PtySpawnResult
  runtime: OpenCodePromptRuntime | undefined
  provider: Pick<IPtyProvider, 'hasPty'>
  connectionId?: string | null
}): void {
  const { env, result, runtime, provider } = options
  const nonce = env?.[OPENCODE_STARTUP_PROMPT_NONCE_ENV]
  const digest = env?.[OPENCODE_STARTUP_PROMPT_SHA256_ENV]
  const launchToken = env?.ORCA_AGENT_LAUNCH_TOKEN
  const incarnation = result.incarnationId
  if (
    options.connectionId ||
    !runtime ||
    result.isReattach ||
    result.agentSessionEnsure?.disposition === 'adopted' ||
    !isPtyIncarnationId(incarnation) ||
    !nonce ||
    !digest ||
    !launchToken
  ) {
    if (nonce) {
      claims.cancel(nonce)
    }
    return
  }
  let unsubscribe = () => {}
  if (
    claims.admit(
      nonce,
      () => {
        if (
          ptyOwnership.get(result.id) !== LOCAL_EXECUTION_HOST_ID ||
          ptyIncarnationById.get(result.id) !== incarnation ||
          provider.hasPty?.(result.id) !== true ||
          runtime.isPtyStopRequested(result.id)
        ) {
          return null
        }
        return runtime.readOpenCodeStartupPromptOwner(result.id, incarnation, launchToken)
      },
      () => unsubscribe()
    )
  ) {
    unsubscribe = runtime.subscribeToPtyExit(result.id, () => claims.cancel(nonce))
  }
}
