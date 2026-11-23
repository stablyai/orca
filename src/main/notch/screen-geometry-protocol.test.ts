import { expect, it } from 'vitest'
import { parseScreenGeometry } from './screen-geometry-protocol'

it('rejects malformed helper rows without losing valid displays or trusting an inverted cutout', () => {
  expect([
    ...parseScreenGeometry(
      '{"displays":[null,7,{}, {"displayId":2,"safeAreaTop":-1},{"displayId":3,"safeAreaTop":32,"notchLeadingOffsetX":800,"notchTrailingOffsetX":700},{"displayId":4,"safeAreaTop":32,"notchLeadingOffsetX":700,"notchTrailingOffsetX":900}]}'
    ).values()
  ]).toEqual([
    { displayId: 3, safeAreaTop: 32, notchLeadingOffsetX: null, notchTrailingOffsetX: null },
    { displayId: 4, safeAreaTop: 32, notchLeadingOffsetX: 700, notchTrailingOffsetX: 900 }
  ])
})
