import { vi } from 'vitest'

// Why: the process worker's entry is build output, absent when tests run from src/, so every file's
// first launch would wait on a worker that can't load. Tests of worker routing mock this themselves.
vi.mock(
  '../../../../src/main/worker-thread-child-process/worker-thread-child-process',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    whenSpawnWorkerReady: async () => false
  })
)
