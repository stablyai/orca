import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ModelManager } from './model-manager'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-speech-models-test'
  }
}))

type ModelManagerInternals = {
  updateState: (
    modelId: string,
    status: 'not-downloaded' | 'downloading' | 'extracting' | 'ready' | 'error',
    progress?: number,
    error?: string
  ) => void
}

describe('ModelManager progress callbacks', () => {
  it('unsubscribes progress callbacks without replacing other listeners', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      const manager = new ModelManager(dir)
      const internals = manager as unknown as ModelManagerInternals
      const first = vi.fn()
      const second = vi.fn()
      const clearFirst = manager.setProgressCallback(first)
      const clearSecond = manager.setProgressCallback(second)

      internals.updateState('model-a', 'downloading', 0.25)
      clearFirst()
      internals.updateState('model-a', 'extracting')
      clearSecond()
      internals.updateState('model-a', 'ready')

      expect(first).toHaveBeenCalledTimes(1)
      expect(first).toHaveBeenCalledWith('model-a', 0.25)
      expect(second).toHaveBeenCalledTimes(2)
      expect(second).toHaveBeenNthCalledWith(1, 'model-a', 0.25)
      expect(second).toHaveBeenNthCalledWith(2, 'model-a', 0.95)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
