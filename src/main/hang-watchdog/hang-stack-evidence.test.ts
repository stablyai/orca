import { expect, it } from 'vitest'
import { reduceHangProfile } from './hang-profile-reducer'

it('retains observed stacks when five equal callers have no stack above twenty percent', () => {
  const result = reduceHangProfile({
    startTime: 0,
    endTime: 100,
    samples: [1, 2, 3, 4, 5],
    nodes: [1, 2, 3, 4, 5].map((id) => ({
      id,
      callFrame: {
        functionName: `caller${id}`,
        scriptId: '1',
        url: '/private/user/app.js',
        lineNumber: 4,
        columnNumber: 2
      }
    }))
  })
  expect(result.stacks.map((item) => [item.frames[0].name, item.count, item.hot])).toEqual([
    ['caller1', 1, false],
    ['caller2', 1, false],
    ['caller3', 1, false]
  ])
  expect(result.stacks[0].frames[0]).toEqual({
    name: 'caller1',
    module: 'app.js',
    line: 5,
    column: 3
  })
})
