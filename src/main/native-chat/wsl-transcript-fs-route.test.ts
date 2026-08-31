import { describe, expect, it } from 'vitest'
import { wslTranscriptFsLaneKey } from './wsl-transcript-fs-route'

describe('WSL transcript filesystem lane keys', () => {
  it('shares one process within a route and priority while isolating other lanes', () => {
    const ubuntu = '\\\\wsl.localhost\\Ubuntu\\home\\ada'

    expect(wslTranscriptFsLaneKey(`${ubuntu}\\one`, 'scan')).toBe(
      wslTranscriptFsLaneKey(`${ubuntu}\\two`, 'scan')
    )
    expect(wslTranscriptFsLaneKey(`${ubuntu}\\one`, 'exact')).not.toBe(
      wslTranscriptFsLaneKey(`${ubuntu}\\one`, 'scan')
    )
    expect(wslTranscriptFsLaneKey(`${ubuntu}\\one`, 'scan')).not.toBe(
      wslTranscriptFsLaneKey('\\\\wsl.localhost\\Debian\\home\\ada\\one', 'scan')
    )
  })
})
