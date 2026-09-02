import type { RpcResponse } from '../runtime/rpc/core'
import type { ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import type { RemoteOrcaCliResult } from './ssh-remote-cli-host-passthrough'
import { formatRemoteCli } from './ssh-remote-cli-format'
import {
  formatRemoteOrchestrationAsk,
  getRemoteCliExitCode
} from './ssh-remote-orchestration-ask-output'
import { formatRemoteOrchestrationCheck } from './ssh-remote-orchestration-check-output'
import { getRemoteCliPostOutput } from './ssh-remote-orchestration-post-output'
import { resolveRemoteCliHandle } from './ssh-remote-cli-args'

export function formatInProcessRemoteCliResult(
  parsed: ParsedRemoteCli,
  env: Record<string, string>,
  response: RpcResponse,
  json: boolean
): RemoteOrcaCliResult {
  const command = parsed.commandPath.join(' ')
  const formatted =
    command === 'orchestration check'
      ? formatRemoteOrchestrationCheck(
          response,
          json,
          resolveRemoteCliHandle(parsed.flags, env, 'terminal'),
          parsed.flags.has('format')
        )
      : command === 'orchestration ask'
        ? formatRemoteOrchestrationAsk(response, json)
        : json
          ? { stdout: `${JSON.stringify(response, null, 2)}\n`, stderr: '' }
          : formatRemoteCli(response)
  const postOutput = getRemoteCliPostOutput(parsed, env, response)
  return {
    stdout: formatted.stdout,
    stderr: formatted.stderr,
    exitCode: getRemoteCliExitCode(command, response),
    ...(postOutput ? { postOutput } : {})
  }
}
