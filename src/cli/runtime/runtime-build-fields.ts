import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'

type RuntimeBuildFields = Pick<
  CliStatusResult['runtime'],
  'appVersion' | 'buildCommit' | 'runtimeProtocolVersion' | 'minCompatibleRuntimeClientVersion'
>

/** Which build answered: `orca status --json` shows it so version skew is visible without the desktop. */
export function runtimeBuildFields(status: RuntimeStatus): RuntimeBuildFields {
  return {
    ...(status.appVersion ? { appVersion: status.appVersion } : {}),
    ...(status.buildCommit ? { buildCommit: status.buildCommit } : {}),
    ...(typeof status.runtimeProtocolVersion === 'number'
      ? { runtimeProtocolVersion: status.runtimeProtocolVersion }
      : {}),
    ...(typeof status.minCompatibleRuntimeClientVersion === 'number'
      ? { minCompatibleRuntimeClientVersion: status.minCompatibleRuntimeClientVersion }
      : {})
  }
}
