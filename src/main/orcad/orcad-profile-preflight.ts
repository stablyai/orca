import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preflightProfileStateRuntime } from '../persistence/profile-state/profile-state-runtime-preflight'
import {
  ORCAD_STARTUP_PREFLIGHT_FLAG,
  ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseOrcadProfilePreflight,
  orcadProfilePreflightResponseSchema,
  type OrcadProfilePreflightResponse
} from '../../shared/orcad-profile-preflight'
import { readOrcadArtifactIdentity } from './orcad-artifact-identity'
import { ORCAD_EXIT_CONFIGURATION } from './orcad-configuration-exit'
import { ORCAD_SERVER_ENTRY_FILENAME, ORCAD_VERSION_FILENAME } from '../../shared/orcad-artifacts'
import { ORCAD_NODE_RUNTIME_IDENTITY } from '../../shared/orcad-node-runtime-identity'
import { runProcess } from '@orca/process-host'
import { preflightOrcadNativeRuntime } from './orcad-runtime-native-preflight'
import { orcadCompileCacheEnv } from './orcad-compile-cache'
import {
  claimStartupPreflightSkip,
  clearAbandonedStartupPreflightClaim,
  computeStartupPreflightFingerprint,
  forgetStartupPreflightVerdict,
  readStartupPreflightVerdict,
  startupPreflightVerdictPath,
  writeStartupPreflightVerdict
} from './orcad-startup-preflight-verdict'
import {
  isRunningAsBundledOrcadRuntime,
  OrcadBundledRuntimeError,
  resolveBundledOrcadSlot
} from './orcad-bundled-runtime'

/** Check every packaged start before a profile index, data-root lock or import is touched. */
export async function preflightBundledOrcadStartup(
  options: { allowVerdict?: boolean } = {}
): Promise<void> {
  const directory = resolveBundledOrcadSlot()
  if (!isRunningAsBundledOrcadRuntime(directory)) {
    return
  }
  const identity = await readInstalledVersion(directory)
  const verdictPath = startupPreflightVerdictPath(directory)
  const fingerprint = verdictPath ? await computeStartupPreflightFingerprint(directory) : null
  if (options.allowVerdict !== false && verdictPath && fingerprint) {
    const verdict = await readStartupPreflightVerdict(verdictPath)
    if (
      verdict?.fingerprint === fingerprint &&
      verdict.artifactVersion === identity &&
      verdict.runtimeVersion === process.versions.node &&
      (await claimStartupPreflightSkip(verdictPath))
    ) {
      return
    }
  }
  // Before the probe: a stale verdict must not survive a probe that fails.
  await forgetStartupPreflightVerdict(verdictPath)
  const nonce = randomUUID()
  // Keep disposable SQLite ownership and native state out of the serving process.
  const result = await runProcess({
    program: process.execPath,
    args: [join(directory, ORCAD_SERVER_ENTRY_FILENAME), ORCAD_STARTUP_PREFLIGHT_FLAG, nonce],
    // The preflight compiles the same bundle again, so it shares the server's code cache.
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ...orcadCompileCacheEnv(directory) },
    timeoutMs: ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    terminationBarrier: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    const Failure = result.code === ORCAD_EXIT_CONFIGURATION ? OrcadBundledRuntimeError : Error
    throw new Failure(`The bundled Orca runtime failed readiness: ${result.stderr}`)
  }
  try {
    parseOrcadProfilePreflight(result.stdout, nonce, ORCAD_NODE_RUNTIME_IDENTITY, identity)
  } catch (cause) {
    throw new OrcadBundledRuntimeError('The bundled runtime returned invalid readiness identity', {
      cause
    })
  }
  // Only what the probe saw: anything replaced while it ran fails the comparison and re-probes.
  if (
    verdictPath &&
    fingerprint &&
    fingerprint === (await computeStartupPreflightFingerprint(directory))
  ) {
    await writeStartupPreflightVerdict(verdictPath, {
      fingerprint,
      artifactVersion: identity,
      runtimeVersion: process.versions.node
    })
    await clearAbandonedStartupPreflightClaim(verdictPath)
  }
}

/** Runs the real probe now, for a start whose skipped probe is in doubt; throws as a start would. */
export function reprobeBundledOrcadStartup(): Promise<void> {
  return preflightBundledOrcadStartup({ allowVerdict: false })
}

/** Only disposable state is opened; no server, profile index or host adapters are installed. */
export async function runOrcadProfilePreflight(
  nonce: string | undefined,
  options: { nativeFeatures?: boolean } = {}
): Promise<void> {
  const checkedNonce = z.string().uuid().parse(nonce)
  const directory = resolveBundledOrcadSlot()
  let artifactVersion: string
  try {
    artifactVersion = await readOrcadArtifactIdentity(directory)
  } catch (cause) {
    throw new OrcadBundledRuntimeError('The bundled Orca artifacts are incomplete or altered', {
      cause
    })
  }
  const result = await preflightProfileStateRuntime()
  // Why only inside the pinned runtime: a host Node rollback launcher never serves this slot.
  if (isRunningAsBundledOrcadRuntime(directory)) {
    await preflightOrcadNativeRuntime(options)
  }
  const response: OrcadProfilePreflightResponse = {
    type: 'orca_profile_state_ready',
    nonce: checkedNonce,
    runtime: 'node',
    runtimeVersion: process.versions.node,
    artifactVersion,
    ...result
  }
  console.log(JSON.stringify(response))
}

async function readInstalledVersion(directory: string): Promise<string> {
  try {
    return orcadProfilePreflightResponseSchema.shape.artifactVersion.parse(
      (await readFile(join(directory, ORCAD_VERSION_FILENAME), 'utf8')).trim()
    )
  } catch (cause) {
    throw new OrcadBundledRuntimeError(
      'The installed Orca artifact version is missing or invalid',
      {
        cause
      }
    )
  }
}
