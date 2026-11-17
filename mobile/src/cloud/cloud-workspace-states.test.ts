import { describe, expect, it } from 'vitest'
import type { Translate } from '../i18n/mobile-i18n'
import { listCloudWorkspaces } from './cloud-control-plane-client'
import { cloudStatusLabel } from './cloud-workspace-display'

const t: Translate = (_key, fallback) => fallback

describe('cloud workspace states (glossary)', () => {
  it('reads unresponsive as Not responding and destroying as Deleting, never Couldn’t start or Going to sleep', async () => {
    const plane = {
      baseUrl: 'https://cp.test',
      token: () => 'tok',
      fetch: async (input: RequestInfo | URL) =>
        new URL(String(input)).pathname === '/v1/sandboxes'
          ? Response.json({
              sandboxes: [
                {
                  id: 'sbx_a',
                  workspaceId: 'ws-a',
                  status: 'unresponsive',
                  machineSize: 'standard',
                  createdAt: 1
                },
                {
                  id: 'sbx_b',
                  workspaceId: 'ws-b',
                  status: 'destroying',
                  machineSize: 'standard',
                  createdAt: 1
                }
              ]
            })
          : Response.json({ error: 'not_found' }, { status: 404 })
    }
    const { workspaces } = await listCloudWorkspaces(plane)
    expect(workspaces.map((w) => [w.status, cloudStatusLabel(w.status, t)])).toEqual([
      ['unresponsive', 'Not responding'],
      ['deleting', 'Deleting']
    ])
  })
})
