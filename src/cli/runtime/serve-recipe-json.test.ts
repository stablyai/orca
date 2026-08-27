import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECIPE_JSON_MAX_BUFFER_BYTES, waitForRecipeJson } from './serve-recipe-json'

class FakeRecipeChild extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('waitForRecipeJson', () => {
  it('rejects and terminates the child when buffered output exceeds the cap', async () => {
    const child = new FakeRecipeChild()
    const waiting = waitForRecipeJson(child as never)
    const oversized = 'x'.repeat(RECIPE_JSON_MAX_BUFFER_BYTES + 1)

    queueMicrotask(() => {
      child.stdout.emit('data', oversized)
    })

    await expect(waiting).rejects.toMatchObject({
      code: 'runtime_serve_failed',
      message: expect.stringContaining(`${RECIPE_JSON_MAX_BUFFER_BYTES} byte buffer`)
    })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.unref).not.toHaveBeenCalled()
  })
})
