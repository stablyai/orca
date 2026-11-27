import { afterEach, expect, it, vi } from 'vitest'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { hydrateShellPath } from './hydrate-shell-path'

const { spawnProcess } = vi.hoisted(() => ({ spawnProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess }))

afterEach(() => vi.restoreAllMocks())

it('preserves PATH characters split across stdout byte chunks', async () => {
  spawnProcess.mockImplementation(() => {
    const child = createFakeSpawnedChild()
    queueMicrotask(() => {
      child.stdout.write(Buffer.from('__ORCA_SHELL_PATH__/tools/'))
      child.stdout.write(Buffer.from([0xe9]))
      child.stdout.write(Buffer.from([0x9b, 0xaa]))
      child.stdout.end(Buffer.from('/bin__ORCA_SHELL_PATH__'))
      child.emit('close', 0, null)
    })
    return child
  })

  await expect(hydrateShellPath({ force: true, shellOverride: 'probe-shell' })).resolves.toEqual({
    ok: true,
    segments: ['/tools/雪/bin'],
    failureReason: 'none'
  })
})
