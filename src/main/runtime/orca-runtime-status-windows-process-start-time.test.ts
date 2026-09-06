import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

const { isWindowsProcessStartTimeAvailable, probeWindowsProcessStartTimeAvailability } = vi.hoisted(
  () => ({
    isWindowsProcessStartTimeAvailable: vi.fn(() => true),
    probeWindowsProcessStartTimeAvailability: vi.fn(async () => true)
  })
)

vi.mock('../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWindowsProcessStartTimeAvailable,
  probeWindowsProcessStartTimeAvailability
}))

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

afterEach(() => {
  setPlatform(originalPlatform)
  isWindowsProcessStartTimeAvailable.mockReturnValue(true)
  probeWindowsProcessStartTimeAvailability.mockReset()
  probeWindowsProcessStartTimeAvailability.mockResolvedValue(true)
})

beforeEach(() => {
  isWindowsProcessStartTimeAvailable.mockClear()
})

describe('runtime status Windows process start-time proof', () => {
  it('keeps the structured RPC surface available when current Windows eligibility is false', () => {
    setPlatform('win32')
    isWindowsProcessStartTimeAvailable.mockReturnValue(false)

    const status = new OrcaRuntimeService().getStatus()

    expect(status.capabilities).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(status).not.toHaveProperty('windowsProcessStartTimeAvailable')
  })

  it('publishes the proof and structured capability when Windows creation time is available', () => {
    setPlatform('win32')
    isWindowsProcessStartTimeAvailable.mockReturnValue(true)

    const status = new OrcaRuntimeService().getStatus()

    expect(status.capabilities).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(status.windowsProcessStartTimeAvailable).toBe(true)
  })

  it('does not publish a Windows-only proof off Windows', () => {
    setPlatform('darwin')

    const status = new OrcaRuntimeService().getStatus()

    expect(status).not.toHaveProperty('windowsProcessStartTimeAvailable')
    expect(status.capabilities).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    expect(isWindowsProcessStartTimeAvailable).not.toHaveBeenCalled()
  })

  it('waits for the Windows proof before publishing runtime capabilities', async () => {
    setPlatform('win32')
    isWindowsProcessStartTimeAvailable.mockReturnValue(false)
    probeWindowsProcessStartTimeAvailability.mockImplementation(async () => {
      isWindowsProcessStartTimeAvailable.mockReturnValue(true)
      return true
    })

    const status = await new OrcaRuntimeService().getStatusAfterWindowsProcessStartTimeProbe()

    expect(probeWindowsProcessStartTimeAvailability).toHaveBeenCalledOnce()
    expect(status.windowsProcessStartTimeAvailable).toBe(true)
    expect(status.capabilities).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
  })
})
