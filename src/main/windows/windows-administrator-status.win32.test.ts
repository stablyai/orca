import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'

describe.runIf(process.platform === 'win32')('native Windows administrator status', () => {
  it('agrees with the independent Windows integrity-level report', async () => {
    const root = resolve(import.meta.dirname, '../../..')
    const launcher = join(root, 'native', 'windows-cli-launcher', '.build', 'orca.exe')
    const [probe, groups] = await Promise.all([
      runProcess({ program: launcher, args: ['--orca-administrator-status'] }),
      runProcess({
        program: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
        args: ['/groups', '/fo', 'csv', '/nh']
      })
    ])
    expect(probe.code).toBe(0)
    expect(groups.code).toBe(0)
    // SID values avoid localized labels; medium, high and system are the supported fixtures.
    const integrity = groups.stdout.match(/S-1-16-(8192|12288|16384)\b/)
    expect(integrity).not.toBeNull()
    expect(probe.stdout.trim()).toBe(integrity?.[1] === '8192' ? 'false' : 'true')
  })
})
