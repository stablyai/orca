import { setFlagsFromString } from 'node:v8'

/**
 * Content-blocking regex rules run synchronously on every browser request; once backtracking runs
 * away, V8 reruns the regex on its linear-time engine. Set early: the stricter `l`-flag engine is
 * unusable here, because enabling it at runtime crashes the process when a worker thread starts.
 */
export function enableLinearRegexpFallback(): void {
  setFlagsFromString('--enable-experimental-regexp-engine-on-excessive-backtracks')
}
