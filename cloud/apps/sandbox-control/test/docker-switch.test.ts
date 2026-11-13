// PARITY-DOCKER: every workspace boot tells the VM whether Docker is on (ORCA_DOCKER), default on;
// SANDBOX_DOCKER=off turns it off everywhere at the next start or wake.
import { describe, expect, it } from 'vitest'
import { START_COMMAND } from '../src/sandbox-vm-commands'
import { createHarness } from './harness'

async function boot(env: Record<string, string> = {}) {
  const h = await createHarness(env)
  const created = await h.call('POST', '/v1/sandboxes', {
    bearer: await h.token('alice', 'acme', 'sandbox', { org_role: 'member' }),
    body: { workspaceId: `ws-${Math.random()}`, machineSize: 'standard' }
  })
  expect(created.status).toBe(200)
  return h.vercel.commands.filter((c) => c.command === START_COMMAND).map((c) => c.env)
}

describe('the Docker switch (SANDBOX_DOCKER)', () => {
  it('is on by default', async () => {
    expect((await boot()).at(-1)?.ORCA_DOCKER).toBe('on')
  })

  it('SANDBOX_DOCKER=off tells the VM to refuse', async () => {
    expect((await boot({ SANDBOX_DOCKER: 'off' })).at(-1)?.ORCA_DOCKER).toBe('off')
    expect((await boot({ SANDBOX_DOCKER: ' OFF ' })).at(-1)?.ORCA_DOCKER).toBe('off')
  })

  it('any other value leaves it on', async () => {
    expect((await boot({ SANDBOX_DOCKER: 'on' })).at(-1)?.ORCA_DOCKER).toBe('on')
  })
})
