import { describe, expect, it } from 'vitest'
import { approvalRerunCommand } from './plugin-runtime'

describe('approvalRerunCommand', () => {
  it('re-runs the exact command with only the approve flag replaced', () => {
    expect(
      approvalRerunCommand(
        ['plugin', 'dev', 'load', '/tmp/my plugin', '--approve', 'ap1-old', '--json'],
        'ap1-new'
      )
    ).toBe(
      `orca plugin dev load ${process.platform === 'win32' ? '"/tmp/my plugin"' : "'/tmp/my plugin'"} --json --approve ap1-new`
    )
    expect(approvalRerunCommand(['plugin', 'enable', 'acme.x', '--approve=ap1-a'], 'ap1-b')).toBe(
      'orca plugin enable acme.x --approve ap1-b'
    )
  })
})
