import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'

export function isRemoteProjectCommand(parsed: ParsedRemoteCli, leaf: string): boolean {
  return (
    parsed.commandPath[0] === 'linear' &&
    parsed.commandPath[1] === 'project' &&
    parsed.commandPath[2] === leaf
  )
}

export function validateRemoteProjectArgs(
  parsed: ParsedRemoteCli,
  options: {
    command: string[]
    allowedFlags: ReadonlySet<string>
    positionalFlag: string
    maxPositionals: number
  }
): void {
  for (const flag of parsed.flags.keys()) {
    if (!options.allowedFlags.has(flag)) {
      throw new RemoteCliArgumentError(
        'invalid_argument',
        `Unknown flag --${flag} for command: ${options.command.join(' ')}`
      )
    }
  }

  const positionals = parsed.commandPath.slice(options.command.length)
  if (positionals.length > options.maxPositionals) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      `Unknown command: ${parsed.commandPath.join(' ')}`
    )
  }
  if (positionals.length > 0 && parsed.flags.has(options.positionalFlag)) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      `Pass --${options.positionalFlag} either positionally or as a flag, not both.`
    )
  }
}

export function remoteProjectPositional(
  parsed: ParsedRemoteCli,
  startIndex: number
): string | undefined {
  const value = parsed.commandPath.slice(startIndex).join(' ').trim()
  return value || undefined
}

export function optionalRemoteProjectString(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function optionalRemoteProjectPositiveInteger(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const raw = optionalRemoteProjectString(flags, name)
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new RemoteCliArgumentError('invalid_argument', `Invalid numeric value for --${name}`)
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new RemoteCliArgumentError('invalid_argument', `Invalid positive integer for --${name}`)
  }
  return value
}

export async function callRemoteLinearProjectMethod(
  dispatcher: RpcDispatcher,
  method: string,
  params: Record<string, unknown>
): Promise<RpcResponse> {
  return await dispatcher.dispatch({
    id: `remote-cli-${Date.now()}`,
    authToken: 'remote-cli',
    method,
    params
  })
}
