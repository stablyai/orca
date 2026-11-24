import { basename, isAbsolute } from 'node:path'
import type { ProviderRelaySpawnSpec } from '../protocol/daemon-provider-relay-protocol'

const PROVIDER_OWNER_EXECUTABLE = 'orca-provider-exec'

const launchString = (value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\0')

/** Untrusted wire input: a launch only of the provider owner, with absolute paths and plain strings. */
export function validProviderRelaySpawnSpec(
  spec: ProviderRelaySpawnSpec | undefined
): spec is ProviderRelaySpawnSpec {
  return (
    !!spec &&
    launchString(spec.command) &&
    spec.command.length > 0 &&
    Array.isArray(spec.args) &&
    spec.args.every(launchString) &&
    launchString(spec.cwd) &&
    isAbsolute(spec.cwd) &&
    launchString(spec.ownerExecutable) &&
    isAbsolute(spec.ownerExecutable) &&
    basename(spec.ownerExecutable) === PROVIDER_OWNER_EXECUTABLE &&
    !!spec.env &&
    typeof spec.env === 'object' &&
    Object.entries(spec.env).every(([key, value]) => launchString(key) && launchString(value)) &&
    (spec.appVersion === undefined || typeof spec.appVersion === 'string') &&
    (spec.entryPath === undefined || typeof spec.entryPath === 'string')
  )
}
