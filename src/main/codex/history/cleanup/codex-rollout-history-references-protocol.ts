/** Messages between the sweep and the worker holding its Codex fork index. */
export type CodexRolloutReferencesRequest =
  | { id: number; op: 'prepare' | 'refresh' | 'refreshBlocked'; homes: readonly string[] }
  | { id: number; op: 'isReferenced'; rolloutId: string }
  | { id: number; op: 'forget'; rolloutId: string; paths: readonly string[] }
  | { id: number; op: 'save' }
  | { op: 'abort' }

export type CodexRolloutReferencesResponse =
  | { id: number; ok: true; value: boolean | string | null | undefined }
  | { id: number; ok: false; name: string; message: string }

export type CodexRolloutReferencesWorkerData = { cachePath: string }
