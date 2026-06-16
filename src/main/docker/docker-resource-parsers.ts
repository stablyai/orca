import type {
  DockerImageSummary,
  DockerNetworkSummary,
  DockerVolumeSummary
} from '../../shared/docker-types'

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseLines<T>(stdout: string, map: (raw: Record<string, unknown>) => T): T[] {
  const out: T[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    out.push(map(raw))
  }
  return out
}

export function parseDockerImages(stdout: string): DockerImageSummary[] {
  return parseLines(stdout, (raw) => ({
    id: str(raw.ID),
    repository: str(raw.Repository),
    tag: str(raw.Tag),
    size: str(raw.Size),
    createdSince: str(raw.CreatedSince)
  }))
}

export function parseDockerVolumes(stdout: string): DockerVolumeSummary[] {
  return parseLines(stdout, (raw) => ({
    name: str(raw.Name),
    driver: str(raw.Driver),
    scope: str(raw.Scope),
    mountpoint: str(raw.Mountpoint)
  }))
}

export function parseDockerNetworks(stdout: string): DockerNetworkSummary[] {
  return parseLines(stdout, (raw) => ({
    id: str(raw.ID),
    name: str(raw.Name),
    driver: str(raw.Driver),
    scope: str(raw.Scope)
  }))
}
