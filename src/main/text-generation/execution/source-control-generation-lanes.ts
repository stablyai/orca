import type { TextGenerationOperation } from '../source-control-text-generation-types'

const cancelTokensByLane = new Map<string, () => void>()

/** `laneId` separates runs that share an operation and cwd, so canceling one never reaches another. */
export function localGenerationLaneKey(
  operation: TextGenerationOperation,
  cwd: string,
  laneId?: string
): string {
  const key = `${operation}:local:${cwd}`
  return laneId ? `${key}:${laneId}` : key
}

export function cancelLocalGeneration(
  operation: TextGenerationOperation,
  cwd: string,
  laneId?: string
): void {
  cancelTokensByLane.get(localGenerationLaneKey(operation, cwd, laneId))?.()
}

export function setLocalGenerationCancelToken(laneKey: string, cancel: () => void): void {
  cancelTokensByLane.set(laneKey, cancel)
}

export function clearLocalGenerationCancelToken(laneKey: string, cancel: () => void): void {
  if (cancelTokensByLane.get(laneKey) === cancel) {
    cancelTokensByLane.delete(laneKey)
  }
}
