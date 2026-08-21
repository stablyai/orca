import {
  cliBooleanFlagValueError,
  parseCliBooleanFlagValue
} from '../../shared/cli-boolean-flag-value'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import {
  foldRemoteFlagOccurrences,
  isRemoteBooleanFlag,
  type RemoteFlagOccurrence
} from './ssh-remote-cli-command-grammar'

export function parseRemoteCliArgs(argv: string[]): ParsedRemoteCli {
  const commandPath: string[] = []
  const occurrences: RemoteFlagOccurrence[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      commandPath.push(token)
      continue
    }
    const assignment = token.slice(2)
    // Why: the SSH relay-backed shim should accept values beginning with `--` via `--flag=value`.
    const equalsIndex = assignment.indexOf('=')
    if (equalsIndex !== -1) {
      const name = assignment.slice(0, equalsIndex)
      const raw = assignment.slice(equalsIndex + 1)
      // Why: parity with the local parser — an uncoerced `--hide-diff=true` reads as off
      // here and silently posts the update with the diff the caller asked to hide.
      if (isRemoteBooleanFlag(name, commandPath)) {
        const enabled = parseCliBooleanFlagValue(raw)
        if (enabled === null) {
          throw new RemoteCliArgumentError('invalid_argument', cliBooleanFlagValueError(name))
        }
        occurrences.push({ name, value: enabled })
        continue
      }
      occurrences.push({ name, value: raw })
      continue
    }

    const flag = assignment
    const next = argv[i + 1]
    // Why: `--description ""` is a real empty value, so only a missing or `--`-leading
    // next token makes the flag boolean; treating '' as absent turned it into a positional.
    if (!isRemoteBooleanFlag(flag, commandPath) && next !== undefined && !next.startsWith('--')) {
      occurrences.push({ name: flag, value: next })
      i += 1
    } else {
      occurrences.push({ name: flag, value: true })
    }
  }
  // Why: repeatability is command-scoped, so occurrences only fold once the full path is known.
  return { commandPath, flags: foldRemoteFlagOccurrences(commandPath, occurrences) }
}

export function resolveRemoteCliHandle(
  flags: Map<string, string | boolean>,
  env: Record<string, string>,
  flagName: string
): string {
  return optionalRemoteCliString(flags, flagName) ?? env.ORCA_TERMINAL_HANDLE ?? 'unknown'
}

export function requiredRemoteCliString(
  flags: Map<string, string | boolean>,
  name: string
): string {
  const value = optionalRemoteCliString(flags, name)
  if (!value) {
    throw new Error(`Missing --${name}`)
  }
  return value
}

export function optionalRemoteCliString(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function optionalRemoteCliNumber(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = optionalRemoteCliString(flags, name)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new RemoteCliArgumentError('invalid_argument', `Invalid numeric value for --${name}`)
  }
  return parsed
}
