import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import { runTypecheckProjects, TYPECHECK_PROJECTS } from './run-typecheck-projects-in-parallel.mjs'

const spawn = vi.fn()
let children
beforeEach(() => {
  children = []
  spawn.mockReset().mockImplementation((spec) => {
    const child = new EventEmitter()
    children.push({ child, spec })
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
})
