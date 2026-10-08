import { describe, expect, it } from 'vitest'
import { countReleaseDownloads } from '../../.github/scripts/render-readme-downloads-badge.mjs'

const asset = (downloads) => ({ download_count: downloads })

describe('README downloads badge', () => {
  it('counts published app releases and skips drafts and agent state rules releases', () => {
    expect(
      countReleaseDownloads([
        { tag_name: 'v1.4.1', draft: false, assets: [asset(10), asset(5)] },
        { tag_name: 'v1.4.2-rc.0', draft: false, assets: [asset(3)] },
        { tag_name: 'mobile-v0.0.1', draft: false, assets: [asset(2)] },
        { tag_name: 'v1.4.3', draft: true, assets: [asset(100)] },
        { tag_name: 'agent-state-rules-engine-1-next', draft: false, assets: [asset(9000)] },
        { tag_name: 'agent-state-rules-engine-1-stable', draft: false, assets: [asset(9000)] }
      ])
    ).toBe(20)
  })
})
