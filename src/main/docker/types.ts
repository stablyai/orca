export type DockerImageHandle = {
  id: string
  cacheKey: string
  dockerfilePath: string
  builtAt: number
}

export type DockerContainerHandle = {
  id: string
  imageId: string
  startedAt: number
  state: 'running' | 'hibernated' | 'terminated'
}

export type DockerTarget = {
  containerId: string
  image: DockerImageHandle
  workdir: string
}

export type DockerEngineFlavor =
  | 'docker-desktop-mac'
  | 'colima'
  | 'docker-engine-linux'
  | 'docker-rootless-linux'
  | 'docker-desktop-windows-wsl2'

export type DockerEngineInfo = {
  flavor: DockerEngineFlavor
  socketPath: string
  available: boolean
  reason?: string
}
