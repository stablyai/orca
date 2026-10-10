import { describe, expect, it, vi } from 'vitest'
import { createPiModelCatalogProbe, piModelCatalogFromListing } from './rpc-model-catalog-probe'

const TABLE = [
  'provider   model            context  max-out  thinking  images',
  'anthropic  claude-sonnet-4  200K     64K      yes       yes',
  'openai     gpt-4o-mini      128K     16K      no        yes'
].join('\n')

describe('Pi model catalog', () => {
  it('reuses the listing identity, with the levels every reasoning model keeps and no default', () => {
    expect(piModelCatalogFromListing(TABLE)).toEqual([
      {
        id: 'anthropic/claude-sonnet-4',
        label: expect.any(String),
        isDefault: false,
        efforts: ['off', 'minimal', 'low', 'medium', 'high'].map((level) => ({
          value: level,
          label: level
        }))
      },
      { id: 'openai/gpt-4o-mini', label: expect.any(String), isDefault: false, efforts: [] }
    ])
  })

  it('lists under the pinned account with the chat launch env, through the shared runner', async () => {
    const runListing = vi.fn(async () => TABLE)
    const probe = createPiModelCatalogProbe({
      resolveEnvironment: async () => ({
        PATH: '/usr/bin',
        HOME: '/home/user',
        ORCA_PANE_KEY: 'p'
      }),
      resolveCommand: () => '/opt/pi/bin/pi',
      probeVersion: async () => true,
      homePath: '/home/user',
      runListing
    })
    const success = await probe({ variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi-a' })
    expect(success.models).toHaveLength(2)
    expect(runListing).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/opt/pi/bin/pi',
        args: ['--list-models'],
        env: expect.objectContaining({ PI_CODING_AGENT_DIR: '/homes/pi-a' })
      }),
      { site: 'pi-model-catalog-probe' }
    )
  })

  it('lists nothing from a Pi that runs no structured chat', async () => {
    const runListing = vi.fn()
    const probe = createPiModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      resolveCommand: () => '/opt/pi/bin/pi',
      probeVersion: async () => false,
      runListing
    })
    await expect(probe({ variable: 'PI_CODING_AGENT_DIR', path: '/homes/pi-a' })).rejects.toThrow(
      /does not run structured chats/
    )
    expect(runListing).not.toHaveBeenCalled()
  })
})
