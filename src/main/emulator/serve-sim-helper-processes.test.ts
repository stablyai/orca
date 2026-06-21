import { describe, expect, it, vi } from 'vitest'
import { parseServeSimHelperProcesses } from './serve-sim-helper-processes'

describe('parseServeSimHelperProcesses', () => {
  it('returns exact serve-sim-bin helper processes from ps output', () => {
    const psOutput = `
      101 /Applications/serve-sim/bin/serve-sim-bin UDID-1 --port 3100
      102 /Applications/serve-sim/bin/serve-sim UDID-1 --port 3100
      103 /tmp/serve-sim-binary UDID-1 --port 3100
      104 node /Applications/serve-sim/bin/serve-sim-bin UDID-2 --port 3101
    `

    expect(parseServeSimHelperProcesses(psOutput)).toEqual([
      {
        pid: 101,
        command: '/Applications/serve-sim/bin/serve-sim-bin UDID-1 --port 3100'
      },
      {
        pid: 104,
        command: 'node /Applications/serve-sim/bin/serve-sim-bin UDID-2 --port 3101'
      }
    ])
  })

  it('scans ps output without line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    try {
      const helpers = parseServeSimHelperProcesses(
        '201 /Applications/serve-sim/bin/serve-sim-bin UDID-1 --port 3100\r\n'
      )
      const usedOutputSplit = splitSpy.mock.calls.some(([separator]) => {
        const pattern = separator as unknown
        return (
          pattern === '\n' ||
          (pattern instanceof RegExp && (pattern.source === '\\r?\\n' || pattern.source === '\\s+'))
        )
      })
      expect(helpers).toHaveLength(1)
      expect(usedOutputSplit).toBe(false)
    } finally {
      splitSpy.mockRestore()
    }
  })
})
