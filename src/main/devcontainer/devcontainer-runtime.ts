/**
 * Runtime glue binding a devcontainer execution host to a {@link DockerPtyProvider}.
 *
 * A host is keyed by its stable `devcontainer.local_folder` (not a container id,
 * which changes on recreate). On each spawn the runtime re-resolves the current
 * container for that key, starts it if stopped, and remembers its mount table so
 * worktree paths can be host→container translated for `docker exec -w`.
 */
import { DockerPtyProvider, type DockerPtyProviderConfig } from './docker-pty-provider'
import { dockerCli, type DockerClient } from './docker-client'
import { listDevcontainers } from './discovery'
import { hostToContainer, type ContainerMount } from './path-map'

/**
 * Env var NAMES forwarded into the container (values via the spawn env, never
 * argv) so in-container agents can authenticate with the user's keys.
 */
export const DEFAULT_DEVCONTAINER_FORWARD_ENV: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY'
]

export type DevcontainerRuntimeConfig = {
  /** Stable host key — the devcontainer's `devcontainer.local_folder`. */
  containerKey: string
  client?: DockerClient
  shell?: string
  forwardEnv?: readonly string[]
  resolveSpawnEnv?: () => Record<string, string>
  ptySpawn?: DockerPtyProviderConfig['ptySpawn']
}

export class DevcontainerRuntime {
  private mounts: ContainerMount[] = []
  private readonly client: DockerClient

  constructor(private readonly config: DevcontainerRuntimeConfig) {
    this.client = config.client ?? dockerCli
  }

  /**
   * Resolve the current container id for this host (running or stopped), start
   * it if needed, and cache its mounts. Throws if no devcontainer matches the
   * key (e.g. the project's devcontainer was removed).
   */
  resolveContainerId = async (): Promise<string> => {
    const infos = await listDevcontainers(this.client, { all: true })
    const info = infos.find((entry) => entry.hostFolder === this.config.containerKey)
    if (!info) {
      throw new Error(`No devcontainer found for "${this.config.containerKey}"`)
    }
    this.mounts = info.mounts
    if (!info.running) {
      await this.client.startContainer(info.containerId)
    }
    return info.containerId
  }

  /** Translate a host worktree path to its in-container path using the last-resolved mounts. */
  hostToContainerCwd = (hostPath: string): string | null => hostToContainer(hostPath, this.mounts)

  /** Build a PTY provider bound to this runtime. */
  createPtyProvider(): DockerPtyProvider {
    return new DockerPtyProvider({
      resolveContainerId: this.resolveContainerId,
      hostToContainerCwd: this.hostToContainerCwd,
      forwardEnv: this.config.forwardEnv ?? DEFAULT_DEVCONTAINER_FORWARD_ENV,
      ...(this.config.shell ? { shell: this.config.shell } : {}),
      ...(this.config.resolveSpawnEnv ? { resolveSpawnEnv: this.config.resolveSpawnEnv } : {}),
      ...(this.config.ptySpawn ? { ptySpawn: this.config.ptySpawn } : {})
    })
  }
}
