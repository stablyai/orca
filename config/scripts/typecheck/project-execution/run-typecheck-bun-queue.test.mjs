import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { runTypecheckProjects, TYPECHECK_PROJECTS } from './run-typecheck-projects-in-parallel.mjs'

const spawn = vi.fn()
let children
let active
let peak
beforeEach(() => {
  children = []
  active = 0
  peak = 0
  spawn.mockReset().mockImplementation((spec) => {
    const child = new EventEmitter()
    children.push({ child, spec })
    active++
    peak = Math.max(peak, active)
    child.once('close', () => {
      active--
    })
    return child
  })
})

function start(memoryBytes = 16 * 1024 ** 3) {
  return runTypecheckProjects({
    compiler: 'bun',
    bunConcurrency: 2,
    bunThreads: 2,
    spawnCompiler: spawn,
    memoryBytes,
    parallelism: 4
  })
}

it('keeps checking after compiler failures and reports errors in project order', async () => {
  const result = start()
  children[1].child.emit('close', 1, null)
  await vi.waitFor(() => expect(children).toHaveLength(3))
  children[0].child.emit('close', null, 'SIGKILL')
  await vi.waitFor(() => expect(children).toHaveLength(4))
  children[2].child.emit('close', 0, null)
  children[3].child.emit('close', 0, null)
  for (let index = 4; index < TYPECHECK_PROJECTS.length; index++) {
    await vi.waitFor(() => expect(children).toHaveLength(index + 1))
    children[index].child.emit('close', 0, null)
  }
  expect((await result).map(({ message }) => message)).toEqual([
    'bun config/tsconfig.node.json exited with signal SIGKILL',
    'bun config/tsconfig.tc.web.json exited with code 1'
  ])
  expect(peak).toBe(2)
})
