import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'
import { getRemoteLinearReadHelp } from './ssh-remote-linear-read-help'
import { tryDispatchRemoteLinearReadCli } from './ssh-remote-linear-read-cli'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-linear-argument-error'
import {
  getRemoteLinearWriteHelp,
  tryDispatchRemoteLinearWriteCli
} from './ssh-remote-linear-write-cli'

export { RemoteCliArgumentError }

export function getRemoteLinearHelp(parsed: ParsedRemoteCli): string | null {
  const helpPath = remoteLinearHelpPath(parsed)
  if (!helpPath) {
    return null
  }
  const readHelp = getRemoteLinearReadHelp(helpPath)
  if (readHelp) {
    return readHelp
  }
  return getRemoteLinearWriteHelp({ ...parsed, commandPath: helpPath })
}

function remoteLinearHelpPath(parsed: ParsedRemoteCli): string[] | null {
  if (parsed.commandPath[0] === 'help' && parsed.commandPath[1] === 'linear') {
    return parsed.commandPath.slice(1)
  }
  if (parsed.flags.has('help') && parsed.commandPath[0] === 'linear') {
    return parsed.commandPath
  }
  return null
}

export async function tryDispatchRemoteLinearCli(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  env: Record<string, string>,
  stdin?: string
): Promise<RpcResponse | null> {
  const readResponse = await tryDispatchRemoteLinearReadCli(dispatcher, parsed, env)
  if (readResponse) {
    return readResponse
  }
  const writeResponse = await tryDispatchRemoteLinearWriteCli(dispatcher, parsed, env, stdin)
  if (writeResponse) {
    return writeResponse
  }
  return null
}
