import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { runPortScanCommand } from './port-scan-command-client'

// Why (#11161): libuv performs process creation inline on the calling thread, so
// this probe runs on the scan worker instead of freezing CrBrowserMain on hosts
// where an endpoint-security hook stalls every spawn. The worker owns the
// command budget, so callers pass no timeout.
type ProbeCommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>
const FIELD_SEPARATOR = '\u0001'

/**
 * Why `--no-trunc` plus an explicit field list rather than `--format json`:
 * a single `docker ps` returns the compose labels alongside the published
 * ports, so one bounded call replaces an N-container `docker inspect` fan-out.
 * The separator is a control character because container names, images and
 * working dirs can all legitimately contain tabs or pipes.
 */
const DOCKER_PS_FORMAT = [
  '{{.ID}}',
  '{{.Names}}',
  '{{.Image}}',
  '{{.Ports}}',
  '{{.Label "com.docker.compose.project"}}',
  '{{.Label "com.docker.compose.project.working_dir"}}',
  '{{.State}}'
].join(FIELD_SEPARATOR)

export type DockerContainerService = {
  containerId: string
  containerName: string
  image: string
  composeProject: string | null
  /** Absolute path of the directory holding the compose file, when compose-managed.
   *  Feeding this to the workspace attributor is what maps a container to a worktree. */
  composeWorkingDir: string | null
  hostPorts: number[]
  state: string
}

export type DockerContainerScan = {
  available: boolean
  containers: DockerContainerService[]
  /** Set only when docker could not be consulted; never set for "no containers". */
  unavailableReason?: string
}

/**
 * Absolute candidates first because Electron's PATH is inherited from the
 * launching context, which on macOS is the login shell only when the app was
 * started from a terminal. A bare `docker` resolves in a dev run and fails in
 * a packaged one.
 */
function dockerBinaryCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    return [`${programFiles}\\Docker\\Docker\\resources\\bin\\docker.exe`, 'docker.exe']
  }
  const home = process.env.HOME ?? ''
  return [
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/docker',
    ...(home ? [`${home}/.docker/bin/docker`] : []),
    '/usr/bin/docker',
    'docker'
  ]
}

export async function resolveDockerBinary(): Promise<string> {
  const candidates = dockerBinaryCandidates()
  for (const candidate of candidates) {
    if (!candidate.includes('/') && !candidate.includes('\\')) {
      continue
    }
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      /* try the next candidate */
    }
  }
  // Why: let PATH resolution have the last word rather than declaring docker
  // absent — a custom install location is more likely than no docker at all.
  return candidates.at(-1) ?? 'docker'
}

/**
 * Parse the published-ports column, e.g.
 * `0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp` -> [5432].
 *
 * UDP mappings are skipped: the port scan this enriches only reports TCP
 * listeners, so a UDP row could never join against one.
 */
export function parseDockerPublishedPorts(value: string): number[] {
  const ports: number[] = []
  const seen = new Set<number>()
  for (const mapping of value.split(',')) {
    const trimmed = mapping.trim()
    if (!trimmed.endsWith('/tcp') || !trimmed.includes('->')) {
      continue
    }
    const hostSide = trimmed.slice(0, trimmed.indexOf('->'))
    const separator = hostSide.lastIndexOf(':')
    if (separator === -1) {
      continue
    }
    // Docker prints a range as `0.0.0.0:8000-8002->8000-8002/tcp`; parsing only
    // the first number would leave listeners on the rest unattributed.
    const [startText, endText] = hostSide.slice(separator + 1).split('-')
    const start = Number.parseInt(startText, 10)
    const end = endText === undefined ? start : Number.parseInt(endText, 10)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end > 65535) {
      continue
    }
    for (let port = start; port <= end; port++) {
      if (seen.has(port)) {
        continue
      }
      seen.add(port)
      ports.push(port)
    }
  }
  return ports
}

export function parseDockerPsOutput(stdout: string): DockerContainerService[] {
  const containers: DockerContainerService[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const fields = line.split(FIELD_SEPARATOR)
    if (fields.length < 7) {
      continue
    }
    const [containerId, containerName, image, ports, composeProject, workingDir, state] = fields
    const hostPorts = parseDockerPublishedPorts(ports)
    if (hostPorts.length === 0) {
      // A container with no published port cannot collide with a local
      // listener, so it has nothing to contribute to the panel.
      continue
    }
    containers.push({
      containerId: containerId.trim().slice(0, 12),
      containerName: containerName.trim(),
      image: image.trim(),
      composeProject: emptyToNull(composeProject),
      composeWorkingDir: emptyToNull(workingDir),
      hostPorts,
      state: state.trim() || 'unknown'
    })
  }
  return containers
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  // Why: docker's template engine renders a missing label as the literal
  // "<no value>", which would otherwise be shown to the user as a project name.
  if (!trimmed || trimmed === '<no value>') {
    return null
  }
  return trimmed
}

export function indexDockerContainersByHostPort(
  containers: readonly DockerContainerService[]
): Map<number, DockerContainerService> {
  const byPort = new Map<number, DockerContainerService>()
  for (const container of containers) {
    for (const port of container.hostPorts) {
      // First writer wins: two containers cannot hold the same host port, so a
      // duplicate means stale output rather than a real second owner.
      if (!byPort.has(port)) {
        byPort.set(port, container)
      }
    }
  }
  return byPort
}

/**
 * List running containers with published ports. Never throws: docker being
 * absent or its daemon being down is an expected state, not an error, and the
 * services panel must still render every local process.
 */
export async function scanDockerContainerServices(
  runCommand: ProbeCommandRunner = runPortScanCommand
): Promise<DockerContainerScan> {
  // Why no guard around resolveDockerBinary: it swallows its own access errors
  // and falls back to PATH, so it cannot reject.
  const binary = await resolveDockerBinary()

  try {
    const { stdout } = await runCommand(binary, ['ps', '--no-trunc', '--format', DOCKER_PS_FORMAT])
    return { available: true, containers: parseDockerPsOutput(stdout) }
  } catch (error) {
    // Why log here: the reason handed to the panel is deliberately short, so
    // without this a failing daemon would leave no diagnostic trace anywhere.
    console.warn('[workspace-services] docker scan failed', error)
    return {
      available: false,
      containers: [],
      unavailableReason: dockerUnavailableReason(error)
    }
  }
}

function dockerUnavailableReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('ENOENT')) {
    return 'Docker is not installed.'
  }
  if (message.includes('timed out')) {
    return 'Docker did not respond.'
  }
  // The daemon-down message is long and shell-shaped; the panel only needs the
  // fact. The caller logs the original error for diagnosis.
  return 'Docker is not running.'
}
