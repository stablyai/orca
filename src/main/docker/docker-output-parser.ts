import type { DockerContainerState, DockerContainerSummary } from '../../shared/docker-types'

const KNOWN_STATES: ReadonlySet<DockerContainerState> = new Set([
  'created',
  'restarting',
  'running',
  'removing',
  'paused',
  'exited',
  'dead'
])

function normalizeState(value: unknown): DockerContainerState {
  const candidate = typeof value === 'string' ? value.toLowerCase() : ''
  return KNOWN_STATES.has(candidate as DockerContainerState)
    ? (candidate as DockerContainerState)
    : 'unknown'
}

// `docker ps --format '{{json .}}'` emits Names and Labels as comma-joined strings
// (CLI formatter context) — not the JSON array/object the raw API / `docker inspect` returns.
function findComposeLabel(labels: unknown, key: string): string | undefined {
  if (typeof labels !== 'string' || labels.length === 0) {
    return undefined
  }
  for (const pair of labels.split(',')) {
    const [k, ...rest] = pair.split('=')
    if (k.trim() === key) {
      const value = rest.join('=').trim()
      return value.length > 0 ? value : undefined
    }
  }
  return undefined
}

function splitNames(names: unknown): string[] {
  if (typeof names !== 'string') {
    return []
  }
  return names
    .split(',')
    .map((name) => name.trim().replace(/^\//, ''))
    .filter((name) => name.length > 0)
}

/**
 * Parse the newline-delimited JSON emitted by `docker ps --format '{{json .}}'`.
 * Malformed lines are skipped so one bad row can't blank the whole list.
 */
export function parseDockerContainers(stdout: string): DockerContainerSummary[] {
  const summaries: DockerContainerSummary[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    // Skip rows without a usable ID: the renderer keys/selects containers by id,
    // so a blank id would collide across rows (duplicate React keys, ambiguous selection).
    const id = typeof raw.ID === 'string' ? raw.ID.trim() : ''
    if (id.length === 0) {
      continue
    }
    summaries.push({
      id,
      names: splitNames(raw.Names),
      image: typeof raw.Image === 'string' ? raw.Image : '',
      state: normalizeState(raw.State),
      status: typeof raw.Status === 'string' ? raw.Status : '',
      composeProject: findComposeLabel(raw.Labels, 'com.docker.compose.project'),
      composeService: findComposeLabel(raw.Labels, 'com.docker.compose.service')
    })
  }
  return summaries
}
