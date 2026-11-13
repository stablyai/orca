import {
  resolveStructuredAgentCommand,
  type StructuredAgentCommandSettings
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import {
  readBundledZcodeAppVersion,
  zcodeBundledLaunch,
  zcodeProviderEnv
} from './zcode-runtime-resolution'
import { ZCODE_APP_SERVER_ARGS } from './zcode-structured-launch-resolution'
import { zcodeStructuredLaunchArgs } from './zcode-structured-launch-args'

// The zcode launch a headless operation (catalog probe, conversation fork) runs: the same
// bundled-first composition a chat session uses, without a chat child of its own.

export type ZcodeHeadlessLaunch = {
  command: string
  args: string[]
  env: Record<string, string>
}

export function zcodeHeadlessLaunch(
  environment: NodeJS.ProcessEnv,
  overrides?: {
    commandSettings?: StructuredAgentCommandSettings
    launchArgs?: string[]
  }
): ZcodeHeadlessLaunch {
  const pathEnv = environment.PATH ?? environment.Path ?? null
  const resolved = resolveStructuredAgentCommand('zcode', overrides?.commandSettings ?? {}, {
    pathEnv,
    ...(environment.HOME ? { homePath: environment.HOME } : {})
  })
  const configuredArgs = zcodeStructuredLaunchArgs(overrides?.launchArgs ?? [])
  const bundled = zcodeBundledLaunch(pathEnv)
  const runtime = bundled ? (bundled.args[0] ?? resolved.command) : resolved.command
  const providerEnv = zcodeProviderEnv(runtime)
  if (providerEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE === undefined) {
    const version = readBundledZcodeAppVersion(runtime)
    if (version) {
      providerEnv.ZCODE_APP_VERSION = version
    }
  }
  // A desktop parent's ZCODE_* variables flip the backend out of the protocol this speaks.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && !(key.startsWith('ZCODE_') && key !== 'ZCODE_HOME')) {
      env[key] = value
    }
  }
  return {
    command: bundled?.command ?? resolved.command,
    args: [
      ...(bundled ? [...bundled.prefixArgs, ...bundled.args] : [...resolved.prefixArgs]),
      ...configuredArgs,
      ...ZCODE_APP_SERVER_ARGS
    ],
    env: { ...env, ...bundled?.env, ...providerEnv }
  }
}
