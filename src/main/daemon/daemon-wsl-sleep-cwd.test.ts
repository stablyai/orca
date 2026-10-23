import { afterEach, describe, expect, it } from 'vitest'
import { readDaemonWslSleepCwd, setDaemonWslSleepCwdReader } from './daemon-wsl-sleep-cwd'

afterEach(() => setDaemonWslSleepCwdReader(null))

describe('readDaemonWslSleepCwd', () => {
  it('spells the folder as a path of its distro', async () => {
    setDaemonWslSleepCwdReader(async () => '/home/jin/repo/deep')
    expect(await readDaemonWslSleepCwd('s', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\deep'
    )
  })

  it("leaves most of Sleep's deadline to the checkpoint when the distro does not answer", async () => {
    setDaemonWslSleepCwdReader(() => new Promise(() => {}))
    const started = Date.now()
    expect(await readDaemonWslSleepCwd('s', 'Ubuntu', started + 400)).toBeNull()
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('reads nothing without a reader, or when the reader fails', async () => {
    expect(await readDaemonWslSleepCwd('s', 'Ubuntu')).toBeNull()
    setDaemonWslSleepCwdReader(async () => {
      throw new Error('wsl_unavailable')
    })
    expect(await readDaemonWslSleepCwd('s', 'Ubuntu')).toBeNull()
  })
})
