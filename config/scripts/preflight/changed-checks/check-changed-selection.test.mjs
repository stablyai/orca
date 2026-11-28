import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { planChangedChecks } from './check-changed-selection.mjs'

it('plans the FIFO unit suite for an edit to only the slot process module', () => {
  const root = join(import.meta.dirname, '..', '..', '..', '..')
  const directory = 'config/scripts/preflight/changed-checks'
  const plan = planChangedChecks([`${directory}/check-changed-slot-processes.mjs`], {
    scriptsDir: join(root, 'config', 'scripts'),
    listDirectory: (dir) => readdirSync(join(root, dir))
  })

  expect(plan.unitTests).toEqual({
    related: [],
    colocated: [`${directory}/check-changed-slot.test.mjs`]
  })
})
