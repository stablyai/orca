// Runs on plain Node, as orcad does: no encoder, so small images pass through.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { ALL_RPC_METHODS } from '../rpc/methods'
import type { RuntimeStore } from '../runtime-store-contract'
import { MAX_REPO_ICON_IDS_PER_READ } from '../../../shared/sidebar-list/repo-icon-data-urls-contract'
import { repoIconId } from './repo-icon-data-urls'
import { pngHeader } from './repo-icon-image-fixture'
import { partialRuntimeStore } from '../runtime-store-partial-fixture'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const upload = {
  type: 'image' as const,
  src: `data:image/png;base64,${Buffer.from(pngHeader(32, 32)).toString('base64')}`,
  source: 'upload' as const
}

function repoIconsMethod() {
  const method = ALL_RPC_METHODS.find((entry) => entry.name === 'sidebarInputs.repoIcons')
  if (!method?.params) {
    throw new Error('sidebarInputs.repoIcons is not registered with params')
  }
  return { method, params: method.params }
}

describe('sidebarInputs.repoIcons', () => {
  it('answers each id from the repos this host shows', async () => {
    const repo = { id: 'r', path: '/r', displayName: 'r', badgeColor: 'blue', addedAt: 1 }
    const store: Pick<RuntimeStore, 'getRepos'> = {
      getRepos: () => [{ ...repo, repoIcon: upload }]
    }
    const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
    const { method, params } = repoIconsMethod()
    const id = repoIconId(upload)

    await expect(
      method.handler(params.parse({ ids: [id, 'unknown'] }), { runtime })
    ).resolves.toEqual({
      icons: [
        { id, dataUrl: upload.src },
        { id: 'unknown', dataUrl: null }
      ]
    })
  })

  it('refuses more ids than one capped reply can carry', () => {
    const ids = Array.from({ length: MAX_REPO_ICON_IDS_PER_READ + 1 }, (_, index) => `id${index}`)
    expect(repoIconsMethod().params.safeParse({ ids }).success).toBe(false)
  })
})
