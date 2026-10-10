import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BaseSequencer } from 'vitest/node'
import RuntimeSequencer from './vitest-runtime-sequencer.mjs'

const timingBaseline = {
  timings: { 'long.test.ts': 100, 'medium.test.ts': 30, 'short.test.ts': 10 },
  overheadMs: 0
}

const context = {
  config: { root: process.cwd() },
  cache: {
    getFileTestResults: () => undefined,
    getFileStats: () => undefined
  }
}
const specification = (file, name, groupOrder = 0, isolate = true) => ({
  moduleId: join(context.config.root, file),
  project: { name, config: { sequence: { groupOrder }, isolate } }
})

it('starts long Node contracts before short Bun files and retains every specification', async () => {
  const specs = [
    specification('short.test.ts', 'bun'),
    specification('unknown.test.ts', 'bun'),
    specification('long.test.ts', 'node-runtime'),
    specification('medium.test.ts', 'node-runtime')
  ]
  const ordered = await new RuntimeSequencer(context, timingBaseline).sort(specs)
  expect(ordered).toEqual([specs[2], specs[3], specs[1], specs[0]])
  expect(new Set(ordered)).toEqual(new Set(specs))
  expect(specs[0].project.name).toBe('bun')
})

it('preserves explicit execution groups and isolation priority', async () => {
  const specs = [
    specification('long.test.ts', 'node-runtime', 1),
    specification('long.test.ts', 'node-runtime', 0, false),
    specification('short.test.ts', 'bun', 0)
  ]
  expect(await new RuntimeSequencer(context, timingBaseline).sort(specs)).toEqual([
    specs[2],
    specs[1],
    specs[0]
  ])
})

it('keeps repeated module paths in distinct projects', async () => {
  const specs = [specification('long.test.ts', 'bun'), specification('long.test.ts', 'node')]
  const ordered = await new RuntimeSequencer(context, timingBaseline).sort(specs)
  expect(ordered).toHaveLength(2)
  expect(new Set(ordered)).toEqual(new Set(specs))
})

it('retains Vitest ordering and default sharding for a single runtime', async () => {
  const specs = [specification('short.test.ts', 'node'), specification('long.test.ts', 'node')]
  const sequencer = new RuntimeSequencer(context, timingBaseline)
  expect(await sequencer.sort(specs)).toEqual(await new BaseSequencer(context).sort(specs))
  expect(sequencer.shard).toBe(BaseSequencer.prototype.shard)
})
