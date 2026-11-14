import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { partialRuntimeStore } from '../../orca-runtime-tests/runtime-store-partial-fixture'
import { publishHeadlessRuntimeGraph } from '../../session-graph/headless-runtime-graph'

const PTY = 'pty-1'
const PHONE = { cols: 50, rows: 30 }

function createRuntime({ headless }: { headless: boolean }) {
  const runtime = new OrcaRuntimeService(partialRuntimeStore())
  const resizes: { cols: number; rows: number }[] = []
  runtime.setPtyController({
    write: () => true,
    resize: (_ptyId, cols, rows) => {
      resizes.push({ cols, rows })
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  if (headless) {
    publishHeadlessRuntimeGraph(runtime)
  }
  return { runtime, resizes }
}

describe('phone viewing on a headless runtime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays passive on a headless host and fits on open on a desktop host', async () => {
    const headless = createRuntime({ headless: true })
    await headless.runtime.handleMobileSubscribe(PTY, 'phone-a', PHONE)
    expect(headless.resizes).toEqual([])
    expect(headless.runtime.getDriver(PTY).kind).not.toBe('mobile')
    expect(headless.runtime.getMobileDisplayMode(PTY)).toBe('desktop')

    const desktopHost = createRuntime({ headless: false })
    await desktopHost.runtime.handleMobileSubscribe(PTY, 'phone-a', PHONE)
    expect(desktopHost.resizes).toEqual([PHONE])
    expect(desktopHost.runtime.getDriver(PTY)).toEqual({ kind: 'mobile', clientId: 'phone-a' })
  })

  it('claims on input and keeps the claim while the PTY is still held at phone size', async () => {
    const { runtime, resizes } = createRuntime({ headless: true })
    await runtime.handleMobileSubscribe(PTY, 'phone-a', PHONE)
    await runtime.beginMobileInputFloor(PTY, 'phone-a')!.commit()
    expect(resizes).toEqual([PHONE])
    expect(runtime.getDriver(PTY)).toEqual({ kind: 'mobile', clientId: 'phone-a' })

    // Default settings hold the phone size after the phone leaves; a reopen resumes the claim.
    runtime.onClientDisconnected('phone-a')
    await runtime.handleMobileSubscribe(PTY, 'phone-a', PHONE)
    expect(runtime.getMobileDisplayMode(PTY)).toBe('auto')
    expect(runtime.getDriver(PTY)).toEqual({ kind: 'mobile', clientId: 'phone-a' })
  })

  it('hands a leaving phone claim to a phone joining within the leave grace, not an orphaned lock', async () => {
    vi.useFakeTimers()
    const { runtime } = createRuntime({ headless: true })
    await runtime.handleMobileSubscribe(PTY, 'phone-a', PHONE)
    await runtime.beginMobileInputFloor(PTY, 'phone-a')!.commit()
    runtime.handleMobileUnsubscribe(PTY, 'phone-a')
    await runtime.handleMobileSubscribe(PTY, 'phone-b', { cols: 60, rows: 32 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runtime.getDriver(PTY)).toEqual({ kind: 'mobile', clientId: 'phone-b' })
  })
})
