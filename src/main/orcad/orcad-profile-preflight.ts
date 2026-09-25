import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preflightProfileStateRuntime } from '../persistence/profile-state/profile-state-runtime-preflight'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseOrcadProfilePreflight,
  type OrcadProfilePreflightResponse
} from '../../shared/orcad-profile-preflight'
import { readOrcadArtifactIdentity } from './orcad-artifact-identity'
import { resolveOrcadInstallRoot } from './orcad-app-paths'
import { ORCAD_VERSION_FILENAME, orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import { runProcess } from '../../shared/child-process/run-process'
import { preflightOrcadBunNativeRuntime } from './orcad-bun-native-preflight'

/** Check every packaged start before a profile index, data-root lock or import is touched. */
export async function preflightBundledOrcadStartup(): Promise<void> {
  if (!process.versions.bun) {
    return
  }
  const directory = resolveOrcadInstallRoot()
  const identity = await readOrcadArtifactIdentity(directory)
  if ((await readFile(join(directory, ORCAD_VERSION_FILENAME), 'utf8')).trim() !== identity) {
    throw new Error('The installed Orca runtime does not match its artifact version')
  }
  const nonce = randomUUID()
  // A Windows PTY probe assigns its process to a job inherited by future children.
  const result = await runProcess({
    program: join(directory, orcadBunRuntimeFilename(process.platform)),
    args: [join(directory, 'orcad.js'), ORCAD_PROFILE_PREFLIGHT_FLAG, nonce],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: ORCAD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024,
    terminationBarrier: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(`The bundled Orca runtime failed readiness: ${result.stderr}`)
  }
  parseOrcadProfilePreflight(result.stdout, nonce, ORCAD_BUN_VERSION, identity)
}

/** Only disposable state is opened; no server, profile index or host adapters are installed. */
export async function runOrcadProfilePreflight(nonce: string | undefined): Promise<void> {
  const checkedNonce = z.string().uuid().parse(nonce)
  const artifactVersion = await readOrcadArtifactIdentity(resolveOrcadInstallRoot())
  const result = await preflightProfileStateRuntime()
  if (process.versions.bun) {
    await preflightOrcadBunNativeRuntime()
  }
  const response: OrcadProfilePreflightResponse = {
    type: 'orca_profile_state_ready',
    nonce: checkedNonce,
    runtime: process.versions.bun ? 'bun' : 'node',
    runtimeVersion: process.versions.bun ?? process.versions.node,
    artifactVersion,
    ...result
  }
  console.log(JSON.stringify(response))
}
