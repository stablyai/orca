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

export const CANCELED_GENERATION_RESULT = {
  success: false,
  error: 'Generation canceled.',
  canceled: true
} as const

/** Holds the lane's cancel token across pre-spawn awaits; a spawned agent replaces it with its own kill token. */
export function runCancelableLocalGeneration<T>(
  operation: TextGenerationOperation,
  cwd: string,
  run: (isCanceled: () => boolean) => Promise<T>
): Promise<T | typeof CANCELED_GENERATION_RESULT> {
  const laneKey = localGenerationLaneKey(operation, cwd)
  let canceled = false
  const canceledBeforeSpawn = Promise.withResolvers<typeof CANCELED_GENERATION_RESULT>()
  const cancel = (): void => {
    canceled = true
    canceledBeforeSpawn.resolve(CANCELED_GENERATION_RESULT)
  }
  setLocalGenerationCancelToken(laneKey, cancel)
  return Promise.race([run(() => canceled), canceledBeforeSpawn.promise]).finally(() =>
    clearLocalGenerationCancelToken(laneKey, cancel)
  )
}
