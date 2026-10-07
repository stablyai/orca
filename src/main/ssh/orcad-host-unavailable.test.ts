import { describe, expect, it } from 'vitest'
import {
  classifyOrcadHostUnavailable,
  orcadCandidateLaunchFailureCode
} from './orcad-host-unavailable'
import { OrcadWindowsLaunchRefusedError } from './orcad-remote-launch-windows'
import { OrcadWindowsCommandLineError } from './orcad-remote-windows-node'

describe('classifyOrcadHostUnavailable', () => {
  it('sends a Windows host that cannot launch orcad back to the relay', () => {
    const refused = new OrcadWindowsLaunchRefusedError('breakaway denied')
    const unsafe = new OrcadWindowsCommandLineError('C:\\Users\\%x%')
    expect(classifyOrcadHostUnavailable(refused)).toBe('unsupported_host')
    expect(classifyOrcadHostUnavailable(unsafe)).toBe('unsupported_host')
    expect(classifyOrcadHostUnavailable({ code: refused.code })).toBe('unsupported_host')
    expect(classifyOrcadHostUnavailable({ code: unsafe.code })).toBe('unsupported_host')
  })

  it('keeps an ordinary launch failure retryable', () => {
    expect(orcadCandidateLaunchFailureCode(new Error('spawn failed'))).toBe(
      'orcad_candidate_launch_failed'
    )
    expect(
      classifyOrcadHostUnavailable({
        code: orcadCandidateLaunchFailureCode(new Error('spawn failed'))
      })
    ).toBeNull()
    expect(orcadCandidateLaunchFailureCode(new OrcadWindowsLaunchRefusedError('x'))).toBe(
      'orcad_windows_launch_refused'
    )
  })
})
