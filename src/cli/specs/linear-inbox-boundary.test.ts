import { expect, it } from 'vitest'
import { COMMAND_SPECS } from './index'

it('keeps personal Linear Inbox and notification access out of the agent CLI schema', () => {
  const linearCommands = COMMAND_SPECS.filter((spec) => spec.path[0] === 'linear')
  expect(linearCommands.length).toBeGreaterThan(0)
  expect(linearCommands.filter((spec) => /inbox|notification/i.test(spec.path.join(' ')))).toEqual(
    []
  )
})
