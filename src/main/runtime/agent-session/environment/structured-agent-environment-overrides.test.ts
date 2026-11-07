import { expect, it } from 'vitest'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'

function tokenCasing(mask: number): string {
  return Array.from('TOKEN', (letter, index) =>
    mask & (1 << index) ? letter.toLowerCase() : letter
  ).join('')
}

it.runIf(process.platform === 'win32')(
  'uses the configured value across every casing of an inherited Windows variable',
  async () => {
    for (let baseCase = 0; baseCase < 32; baseCase += 1) {
      for (let overlayCase = 0; overlayCase < 32; overlayCase += 1) {
        const baseKey = tokenCasing(baseCase)
        const overlayKey = tokenCasing(overlayCase)
        const inherited = Object.freeze({ [baseKey]: 'inherited', KEEP: 'kept' })
        const overlay = Object.freeze({ [overlayKey]: 'configured' })
        const resolver = createStructuredAgentEnvironmentResolvers({
          resolveEnvironment: async () => inherited,
          resolveAgentLaunchEnv: () => overlay
        })
        const env = await resolver.resolveAgentEnvironment('claude')
        expect(Object.entries(env).filter(([key]) => key.toUpperCase() === 'TOKEN')).toEqual([
          [overlayKey, 'configured']
        ])
        expect(env.KEEP).toBe('kept')
        expect(inherited[baseKey]).toBe('inherited')
      }
    }
  }
)
