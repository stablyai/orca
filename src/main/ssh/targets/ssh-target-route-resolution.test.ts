import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import { parseSshGOutput } from '../config/ssh-g-config-resolution'
import { resolveSshRouteKeys } from './ssh-target-route-resolution'

const target = (index: number): SshTarget => ({
  id: `ssh-${index}`,
  label: `host-${index}`,
  configHost: `host-${index}`,
  host: `host-${index}`,
  port: 22,
  username: '',
  source: 'ssh-config'
})

describe('resolveSshRouteKeys', () => {
  it('runs at most four ssh -G at once', async () => {
    let active = 0
    let peak = 0
    const waiting: (() => void)[] = []
    const answer = (alias: string) => parseSshGOutput(`hostname ${alias}\nuser me\nport 22`)
    const config = async (alias: string) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((release) => waiting.push(release))
      active -= 1
      return answer(alias)
    }
    const resolvers = {
      config,
      systemRoute: async (route: SshTarget) => answer(route.configHost ?? route.host),
      aliasClaimed: () => true
    }
    const targets = Array.from({ length: 12 }, (_, index) => target(index))

    const lookups = resolveSshRouteKeys(targets, resolvers)
    let released = 0
    for (let spins = 0; released < targets.length && spins < 1000; spins += 1) {
      const release = waiting.shift()
      if (release) {
        released += 1
        release()
      }
      await Promise.resolve()
    }
    await lookups

    expect(released).toBe(targets.length)

    expect(peak).toBe(4)
  })
})
