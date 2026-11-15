import { describe, expect, it } from 'vitest'
import { parseWmSize } from './adb-devices'

describe('parseWmSize', () => {
  it('prefers Override size over Physical size when both are present', () => {
    const stdout = 'Physical size: 1080x2340\nOverride size: 720x1560\n'
    expect(parseWmSize(stdout)).toEqual({ width: 720, height: 1560 })
  })
})
