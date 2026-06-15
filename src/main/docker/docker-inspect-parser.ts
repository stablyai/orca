import type {
  DockerContainerInspect,
  DockerContainerMount,
  DockerContainerPortBinding
} from '../../shared/docker-types'

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseMounts(raw: unknown): DockerContainerMount[] {
  if (!Array.isArray(raw)) return []
  return raw.map((m) => {
    const mount = (m ?? {}) as Record<string, unknown>
    return {
      type: str(mount.Type),
      source: str(mount.Source),
      destination: str(mount.Destination),
      mode: str(mount.Mode),
      // Docker omits RW (defaults true) on read-write mounts; only `false` means read-only.
      rw: mount.RW !== false
    }
  })
}

function parsePorts(raw: unknown): DockerContainerPortBinding[] {
  if (typeof raw !== 'object' || raw === null) return []
  const bindings: DockerContainerPortBinding[] = []
  for (const [containerPort, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length > 0) {
      for (const b of value) {
        const bind = (b ?? {}) as Record<string, unknown>
        bindings.push({ containerPort, hostIp: str(bind.HostIp), hostPort: str(bind.HostPort) })
      }
    } else {
      // Exposed but unpublished (Docker stores null) — surface it with empty host fields.
      bindings.push({ containerPort, hostIp: '', hostPort: '' })
    }
  }
  return bindings
}

/** Parse `docker inspect <id>` output (a JSON array). Returns null on malformed/empty input. */
export function parseDockerInspect(stdout: string): DockerContainerInspect | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const raw = (parsed[0] ?? {}) as Record<string, unknown>
  const config = (raw.Config ?? {}) as Record<string, unknown>
  const hostConfig = (raw.HostConfig ?? {}) as Record<string, unknown>
  const restartPolicy = (hostConfig.RestartPolicy ?? {}) as Record<string, unknown>
  const networkSettings = (raw.NetworkSettings ?? {}) as Record<string, unknown>
  return {
    id: str(raw.Id),
    createdAt: str(raw.Created),
    env: Array.isArray(config.Env) ? config.Env.filter((e): e is string => typeof e === 'string') : [],
    mounts: parseMounts(raw.Mounts),
    ports: parsePorts(networkSettings.Ports),
    restartPolicy: str(restartPolicy.Name)
  }
}
