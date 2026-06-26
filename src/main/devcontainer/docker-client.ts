/**
 * Minimal Docker CLI client for devcontainer discovery.
 *
 * Talks to the local Docker daemon (OrbStack provides the standard `docker`
 * binary + socket) by shelling out to the CLI via the repo's cross-platform
 * `commandExecFileAsync` runner — no new dependency, same pattern Orca uses for
 * git. Only the read-only operations discovery needs are exposed.
 */
import { commandExecFileAsync } from '../git/runner'

/** Default wall-clock budget for a single docker invocation. */
const DOCKER_TIMEOUT_MS = 10_000
/** `docker inspect` of a large container can exceed Node's 1 MB exec default. */
const DOCKER_MAX_BUFFER = 16 * 1024 * 1024

/** One row of `docker ps --format '{{json .}}'` (subset of fields we use). */
export type DockerPsEntry = {
  ID: string
  Names: string
  Image?: string
  State?: string
  Status?: string
  Labels?: string
}

/** One mount from `docker inspect` `.Mounts[]` (subset). */
export type DockerInspectMount = {
  Type?: string
  Source?: string
  Destination?: string
}

/** Subset of a single `docker inspect <id>` array element. */
export type DockerInspect = {
  Id: string
  Name?: string
  Config?: { Labels?: Record<string, string> | null }
  Mounts?: DockerInspectMount[]
  State?: { Running?: boolean }
}

/** Docker surface discovery + runtime depend on. Injectable so callers/tests can stub it. */
export type DockerClient = {
  /** List containers carrying `label`. By default running only; `all` includes stopped. */
  listContainersByLabel(label: string, opts?: { all?: boolean }): Promise<DockerPsEntry[]>
  inspectContainer(id: string): Promise<DockerInspect | null>
  /** Start a stopped container (no-op if already running). */
  startContainer(id: string): Promise<void>
}

async function runDocker(args: string[]): Promise<string> {
  const { stdout } = await commandExecFileAsync('docker', args, {
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: DOCKER_MAX_BUFFER
  })
  return stdout
}

/**
 * List running containers carrying `label`. `docker ps --format '{{json .}}'`
 * emits one JSON object per line (NDJSON), not a JSON array, so parse per line.
 */
async function listContainersByLabel(
  label: string,
  opts: { all?: boolean } = {}
): Promise<DockerPsEntry[]> {
  const args = ['ps']
  if (opts.all) {
    args.push('-a')
  }
  args.push('--filter', `label=${label}`, '--format', '{{json .}}')
  const stdout = await runDocker(args)
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DockerPsEntry)
}

async function inspectContainer(id: string): Promise<DockerInspect | null> {
  const stdout = await runDocker(['inspect', id])
  const parsed = JSON.parse(stdout) as DockerInspect[]
  // Why nullable: `docker inspect` returns `[]` for an id that vanished between
  // listing and inspecting (container removed mid-discovery).
  return parsed[0] ?? null
}

async function startContainer(id: string): Promise<void> {
  await runDocker(['start', id])
}

/** Default client backed by the local `docker` CLI. */
export const dockerCli: DockerClient = {
  listContainersByLabel,
  inspectContainer,
  startContainer
}
