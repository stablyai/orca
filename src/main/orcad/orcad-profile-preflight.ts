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
  consumeOrcadStartupQualification,
  discardOrcadStartupQualification,
  isQualifiableOrcadSlot,
  orcadStartupQualificationKey,
  recordOrcadStartupQualification
} from './orcad-startup-qualification'
import {
  isRunningAsBundledOrcadRuntime,
  OrcadBundledRuntimeError,
  resolveBundledOrcadSlot
} from './orcad-bundled-runtime'

let pendingQualification: { directory: string; key: string } | null = null

/** Qualify packaged startup before touching profile indexes, data-root locks or imports. */
export async function preflightBundledOrcadStartup(): Promise<void> {
  const directory = resolveBundledOrcadSlot()
  if (!isRunningAsBundledOrcadRuntime(directory)) {
    return
  }
  const identity = await readInstalledVersion(directory)
  // Windows' child also proves the process identity table, which depends on host services.
  const key =
    process.platform === 'win32' || !isQualifiableOrcadSlot(directory)
      ? null
      : await orcadStartupQualificationKey(directory, identity).catch(() => null)
  if (key && (await consumeOrcadStartupQualification(directory, key))) {
    pendingQualification = { directory, key }
    return
  }
  try {
    await runStartupPreflightChild(directory, identity)
  } catch (error) {
    if (key) {
      await discardOrcadStartupQualification(directory)
    }
    throw error
  }
  pendingQualification = key ? { directory, key } : null
}

async function runStartupPreflightChild(directory: string, identity: string): Promise<void> {
  const nonce = randomUUID()
  // Keep disposable SQLite ownership and native state out of the serving process.
  const result = await runProcess({
    program: process.execPath,
    args: [join(directory, ORCAD_SERVER_ENTRY_FILENAME), ORCAD_STARTUP_PREFLIGHT_FLAG, nonce],
    // Reuse the serving runtime code cache for this identical bundle.
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
}

/** Call once readiness is published: only a launch that got there lets the next one skip. */
export async function confirmBundledOrcadStartupQualified(): Promise<void> {
  const qualified = pendingQualification
  pendingQualification = null
  if (qualified) {
    await recordOrcadStartupQualification(qualified.directory, qualified.key)
  }
}

export async function runOrcadProfilePreflight(
  nonce: string | undefined,
  options: { nativeFeatures?: boolean; servedUserDataPath?: string } = {}
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
  // Host Node rollback launchers do not serve the bundled slot.
  if (isRunningAsBundledOrcadRuntime(directory)) {
    await preflightOrcadNativeRuntime(options)
  }
  const response: OrcadProfilePreflightResponse = {
    type: 'orca_profile_state_ready',
    nonce: checkedNonce,
    runtime: 'node',
    runtimeVersion: process.versions.node,
    artifactVersion,
    ...result,
    ...(options.servedUserDataPath === undefined
      ? {}
      : { liveDaemonProtocols: await readServedDaemonProtocols(options.servedUserDataPath) })
  }
  console.log(JSON.stringify(response))
}

/** The served data root, never this probe's own, decides which daemons a restart must reach. */
async function readServedDaemonProtocols(servedUserDataPath: string): Promise<number[] | null> {
  // A failed probe leaves the crossing unverifiable; it must not fail the candidate itself.
  try {
    // Import lazily: startup preflight loads this module and needs no daemon code.
    const [{ listLiveDaemonProtocols }, { daemonRuntimeDirFor }, protocol] = await Promise.all([
      import('../daemon/daemon-generation-liveness'),
      import('../daemon/daemon-runtime-dir'),
      import('../daemon/daemon-protocol-version')
    ])
    return await listLiveDaemonProtocols(daemonRuntimeDirFor(servedUserDataPath), [
      protocol.PROTOCOL_VERSION,
      ...protocol.PREVIOUS_DAEMON_PROTOCOL_VERSIONS
    ])
  } catch {
    return null
  }
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
