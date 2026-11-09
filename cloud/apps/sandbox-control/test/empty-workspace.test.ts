import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'

describe('a workspace started without a repo ("Start empty")', () => {
  it('still runs the prelude, which makes an empty repository Orca can open', async () => {
    const h = await createHarness()
    const created = await h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'empty', machineSize: 'standard' }
    })
    expect(created.status).toBe(200)
    const start = h.vercel.commands.filter((c) => c.command === '/opt/orca/bin/orca-sandbox-start').at(-1)!
    expect(start.env.ORCA_REPO_URL).toBeUndefined()
    expect(start.env.ORCA_PRELUDE).toContain('git init --quiet "$P"')
  })
})
