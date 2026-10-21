import { afterEach, describe, expect, it, vi } from 'vitest'
import { unservedHostServerMessage } from './ssh-host-unserved-status'

const { isPackaged } = vi.hoisted(() => ({ isPackaged: vi.fn(() => true) }))
vi.mock('../../shared/app-environment', () => ({
  hasAppEnvironment: () => true,
  getAppEnvironment: () => ({ isPackaged })
}))

afterEach(() => isPackaged.mockReset())

describe('unservedHostServerMessage', () => {
  const missingTemplate = {
    route: 'unserved' as const,
    reason: 'orcad_unavailable' as const,
    detail: 'artifacts_unavailable'
  }

  it('tells a development build how to get a server template', () => {
    isPackaged.mockReturnValue(false)
    expect(unservedHostServerMessage(missingTemplate)).toContain('ORCA_ORCAD_TEMPLATE_PATH')
  })

  it('keeps the packaged-build wording, and other unavailable causes, unchanged', () => {
    isPackaged.mockReturnValue(true)
    expect(unservedHostServerMessage(missingTemplate)).toContain(
      'isn’t supported by this version of Orca'
    )
    isPackaged.mockReturnValue(false)
    expect(unservedHostServerMessage({ ...missingTemplate, detail: 'unsupported_host' })).toContain(
      'isn’t supported by this version of Orca'
    )
  })
})
