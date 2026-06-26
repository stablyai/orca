/**
 * Devcontainer discovery.
 *
 * Finds running devcontainers and extracts the data the devcontainer execution
 * host needs: a stable key, display name, the host workspace folder (the bind
 * mount Orca manages git/files on), and the full mount table (for host↔container
 * path translation). A devcontainer is any container carrying the standard
 * `devcontainer.local_folder` label set by the Dev Containers tooling.
 */
import { dockerCli, type DockerClient, type DockerInspect } from './docker-client'
import type { ContainerMount, DevcontainerInfo } from '../../shared/devcontainer-types'

export type { DevcontainerInfo }

/** Label the Dev Containers spec/tooling sets to the host workspace folder. */
export const DEVCONTAINER_LOCAL_FOLDER_LABEL = 'devcontainer.local_folder'
/** Label pointing at the devcontainer.json used (optional, informational). */
export const DEVCONTAINER_CONFIG_FILE_LABEL = 'devcontainer.config_file'

/**
 * Build a {@link DevcontainerInfo} from a `docker inspect` result, or null when
 * the container is not a devcontainer (missing `devcontainer.local_folder`).
 * Pure — unit-tested without Docker.
 */
export function parseDevcontainer(inspect: DockerInspect): DevcontainerInfo | null {
  const labels = inspect.Config?.Labels ?? {}
  const hostFolder = labels[DEVCONTAINER_LOCAL_FOLDER_LABEL]
  if (!hostFolder) {
    return null
  }
  const mounts: ContainerMount[] = (inspect.Mounts ?? [])
    .filter(
      (mount): mount is { Source: string; Destination: string } =>
        typeof mount.Source === 'string' &&
        mount.Source.length > 0 &&
        typeof mount.Destination === 'string' &&
        mount.Destination.length > 0
    )
    .map((mount) => ({ source: mount.Source, destination: mount.Destination }))

  return {
    containerId: inspect.Id,
    // Why strip the slash: docker reports `/cranky_swartz`; the leading slash is
    // a docker artifact, not part of the name users or `docker exec` need.
    name: (inspect.Name ?? '').replace(/^\//, ''),
    hostFolder,
    configFile: labels[DEVCONTAINER_CONFIG_FILE_LABEL] ?? null,
    running: inspect.State?.Running ?? false,
    mounts
  }
}

/**
 * List running devcontainers. Resolves each candidate via `docker inspect`
 * (labels alone don't carry the mount table). Containers that disappear between
 * listing and inspecting, or that fail to parse, are skipped rather than fatal.
 */
export async function listDevcontainers(
  client: DockerClient = dockerCli,
  opts: { all?: boolean } = {}
): Promise<DevcontainerInfo[]> {
  const entries = await client.listContainersByLabel(DEVCONTAINER_LOCAL_FOLDER_LABEL, opts)
  const inspected = await Promise.all(
    entries.map(async (entry) => {
      try {
        const inspect = await client.inspectContainer(entry.ID)
        return inspect ? parseDevcontainer(inspect) : null
      } catch {
        return null
      }
    })
  )
  return inspected.filter((info): info is DevcontainerInfo => info !== null)
}
