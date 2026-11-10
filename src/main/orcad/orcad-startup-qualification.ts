// A slot qualified once on an unchanged host need not re-run the disposable startup preflight.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import process from 'node:process'
import {
  ORCAD_MANAGED_ACTIVATION_ROOT_ENV,
  ORCAD_STARTUP_QUALIFICATION_DIR_ENV
} from '../../shared/orcad-managed-launch-env'
import { ORCAD_NODE_RUNTIME_IDENTITY } from '../../shared/orcad-node-runtime-identity'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { listOrcadArtifactFilenames } from './orcad-artifact-identity'
import { detectNativeHostAbi } from './native-host-abi'

export const ORCAD_STARTUP_QUALIFIED_FILENAME = '.orcad-startup-qualified'
const ARTIFACT_STAT_CONCURRENCY = 16

// Launch environment that changes how Node, its native modules or the probe's temp files behave.
const ORCAD_STARTUP_QUALIFICATION_ENV = [
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'TMPDIR'
] as const

function qualificationDirOverride(env: NodeJS.ProcessEnv): string | null {
  const directory = env[ORCAD_STARTUP_QUALIFICATION_DIR_ENV]
  return directory && isAbsolute(directory) ? directory : null
}

function markerPath(directory: string, env: NodeJS.ProcessEnv): string {
  return join(qualificationDirOverride(env) ?? directory, ORCAD_STARTUP_QUALIFIED_FILENAME)
}

/**
 * Only a slot a client materialized and launched as managed (SSH, WSL), or one whose launcher
 * names a marker directory, may be qualified; app bundles and resources stay unwritten, as with
 * the compile cache.
 */
export function isQualifiableOrcadSlot(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath: string | undefined = process.resourcesPath
): boolean {
  if (!env[ORCAD_MANAGED_ACTIVATION_ROOT_ENV] && !qualificationDirOverride(env)) {
    return false
  }
  if (!resourcesPath) {
    return true
  }
  const inside = relative(resourcesPath, directory)
  return inside.startsWith('..') || isAbsolute(inside)
}

/**
 * What the preflight's verdict depends on: the slot's code and installed bytes (stat identity,
 * so a replaced or rewritten file re-qualifies), the runtime, and the host's libc and kernel.
 */
export async function orcadStartupQualificationKey(
  directory: string,
  artifactVersion: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const filenames = await listOrcadArtifactFilenames(directory)
  // Startup path: overlap the independent stats; hash in listing order so the key is unchanged.
  const stats = await mapWithConcurrency(filenames, ARTIFACT_STAT_CONCURRENCY, (filename) =>
    stat(join(directory, filename))
  )
  const files = createHash('sha256')
  for (const [index, { size, mtimeMs, ctimeMs, ino }] of stats.entries()) {
    files.update(JSON.stringify([filenames[index], size, mtimeMs, ctimeMs, ino]))
  }
  const launchEnv = createHash('sha256')
    .update(JSON.stringify(ORCAD_STARTUP_QUALIFICATION_ENV.map((name) => env[name] ?? null)))
    .digest('hex')
  const abi = detectNativeHostAbi()
  return JSON.stringify({
    // 2: the marker now also vouches for the node-pty probe; older markers don't.
    schema: 2,
    artifactVersion,
    runtime: ORCAD_NODE_RUNTIME_IDENTITY,
    node: process.versions.node,
    // The executable that ran: a slot re-pointed at another Node build must re-qualify.
    execPath: process.execPath,
    abi,
    kernel: release(),
    launchEnv,
    files: files.digest('hex')
  })
}

/**
 * True when the last launch with this key reached readiness. The marker is removed here, so a
 * launch that fails or crashes before readiness leaves the next one to re-qualify.
 */
export async function consumeOrcadStartupQualification(
  directory: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const marker = markerPath(directory, env)
  try {
    if ((await readFile(marker, 'utf8')) !== key) {
      return false
    }
    await unlink(marker)
    return true
  } catch {
    // Unreadable, unparsable or undeletable: qualify as before.
    return false
  }
}

/** A failed preflight voids any marker, including one a concurrent launch is about to rely on. */
export async function discardOrcadStartupQualification(
  directory: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await unlink(markerPath(directory, env)).catch(() => {})
}

/** Written only after readiness; temp + rename so a torn write never matches. Fails open. */
export async function recordOrcadStartupQualification(
  directory: string,
  key: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const marker = markerPath(directory, env)
  const temporary = `${marker}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(marker), { recursive: true, mode: 0o700 })
    await writeFile(temporary, key, { mode: 0o600 })
    await rename(temporary, marker)
  } catch {
    await unlink(temporary).catch(() => {})
  }
}
