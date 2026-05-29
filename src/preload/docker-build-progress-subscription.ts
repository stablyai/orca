import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type { DockerBuildProgress } from '../shared/types'

const DOCKER_BUILD_PROGRESS_CHANNEL = 'docker:build-progress'

export function subscribeDockerBuildProgress(
  ipc: Pick<IpcRenderer, 'on' | 'removeListener'>,
  callback: (data: DockerBuildProgress) => void
): () => void {
  const listener = (_event: IpcRendererEvent, data: DockerBuildProgress): void => callback(data)
  ipc.on(DOCKER_BUILD_PROGRESS_CHANNEL, listener)
  return () => ipc.removeListener(DOCKER_BUILD_PROGRESS_CHANNEL, listener)
}
