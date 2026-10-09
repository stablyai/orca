import { expect, it } from 'vitest'
import { permissionDefaultHost } from './structured-permission-default.test-fixture'

it.each([
  ['claude', {}, 'ask'],
  ['codex', {}, 'ask'],
  ['codex', { approvalsReviewer: 'user' }, 'ask'],
  ['codex', { approvalsReviewer: 'auto_review' }, 'auto']
] as const)('derives fixed %s legacy intent %j as %s', async (agent, options, expected) => {
  for (const initial of ['ask', 'bypass'] as const) {
    const host = await permissionDefaultHost(agent, initial, options)
    try {
      const before = await host.storedIntent()
      expect(host.fact()).toEqual({ mode: expected, fence: 7, revision: 0 })
      expect((await host.readOptions()).permissionModes?.current).toBe(expected)
      host.changeDefault(initial === 'ask' ? 'bypass' : 'ask')
      await host.publish()
      expect(host.frames).toHaveLength(1)
      expect((await host.readOptions()).permissionModes?.current).toBe(expected)
      expect(host.fact()).toEqual({ mode: expected, fence: 7, revision: 0 })
      expect(await host.storedIntent()).toEqual(before)
      await host.restart()
      expect(host.fact()).toEqual({ mode: expected, fence: 7, revision: 0 })
      expect(await host.storedIntent()).toMatchObject({ options, permissionRevision: 0 })
    } finally {
      await host.close()
    }
  }
})
