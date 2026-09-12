import type { TextGenerationOperation } from './source-control-text-generation-types'

const cancelTokensByLane = new Map<string, () => void>()

export function localGenerationLaneKey(operation: TextGenerationOperation, cwd: string): string {
  return `${operation}:local:${cwd}`
}

export function cancelLocalGeneration(operation: TextGenerationOperation, cwd: string): void {
  cancelTokensByLane.get(localGenerationLaneKey(operation, cwd))?.()
}

export function setLocalGenerationCancelToken(laneKey: string, cancel: () => void): void {
  cancelTokensByLane.set(laneKey, cancel)
}

export function clearLocalGenerationCancelToken(laneKey: string, cancel: () => void): void {
  if (cancelTokensByLane.get(laneKey) === cancel) {
    cancelTokensByLane.delete(laneKey)
  }
}
