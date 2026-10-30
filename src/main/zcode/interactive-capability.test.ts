import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))

import {
  _resetZCodeInteractiveCapabilityForTests,
  readZCodeInteractiveCapability
} from './interactive-capability'
import type { ZcodeCliInvocation } from './zcode-cli-invocation'

const desktopInvocation: ZcodeCliInvocation = {
  command: '/opt/ZCode/zcode',
  prefixArgs: ['/opt/ZCode/resources/glm/zcode.cjs'],
  envOverlay: { ELECTRON_RUN_AS_NODE: '1' },
  identity: 'desktop',
  source: 'desktop-bundle'
}

beforeEach(() => {
  mocks.runProcess.mockReset()
  _resetZCodeInteractiveCapabilityForTests()
})

describe('readZCodeInteractiveCapability', () => {
  it('probes the exact CLI invocation and explicit tui command', async () => {
    mocks.runProcess.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: "Cannot find package '@zcode/tui'",
      timedOut: false
    })

    await expect(readZCodeInteractiveCapability(desktopInvocation)).resolves.toBe('missing-tui')
    const spec = mocks.runProcess.mock.calls[0]?.[0]
    expect(spec).toMatchObject({
      program: '/opt/ZCode/zcode',
      args: ['/opt/ZCode/resources/glm/zcode.cjs', 'tui'],
      input: '',
      timeoutMs: 6_000
    })
    expect(spec.env?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('treats a TUI that stays alive through the probe as interactive', async () => {
    mocks.runProcess.mockResolvedValue({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })

    await expect(readZCodeInteractiveCapability(desktopInvocation)).resolves.toBe('interactive')
    await readZCodeInteractiveCapability(desktopInvocation)

    expect(mocks.runProcess).toHaveBeenCalledTimes(1)
  })

  it('keeps missing-TUI output authoritative when termination times out', async () => {
    mocks.runProcess.mockResolvedValue({
      code: null,
      stdout: '',
      stderr: "Cannot find package '@zcode/tui'",
      timedOut: true
    })

    await expect(readZCodeInteractiveCapability(desktopInvocation)).resolves.toBe('missing-tui')
  })

  it.each(['TUI requires an interactive terminal.', 'TUI 需要交互式终端。'])(
    'recognizes an official non-TTY diagnostic as interactive: %s',
    async (stderr) => {
      mocks.runProcess.mockResolvedValue({ code: 1, stdout: '', stderr, timedOut: false })

      await expect(readZCodeInteractiveCapability(desktopInvocation)).resolves.toBe('interactive')
      await readZCodeInteractiveCapability(desktopInvocation)

      expect(mocks.runProcess).toHaveBeenCalledTimes(1)
    }
  )

  it('does not classify an unrecognized non-zero exit as interactive', async () => {
    mocks.runProcess.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'not a tty',
      timedOut: false
    })

    await expect(readZCodeInteractiveCapability(desktopInvocation)).resolves.toBe('unknown')
    await readZCodeInteractiveCapability(desktopInvocation)

    expect(mocks.runProcess).toHaveBeenCalledTimes(2)
  })

  it('caches definitive verdicts by invocation identity', async () => {
    mocks.runProcess.mockResolvedValue({ code: 0, stdout: '', stderr: '', timedOut: false })
    const standalone = {
      ...desktopInvocation,
      command: '/usr/local/bin/zcode',
      prefixArgs: [],
      envOverlay: {},
      identity: 'standalone',
      source: 'standalone' as const
    }

    await expect(readZCodeInteractiveCapability(desktopInvocation)).resolves.toBe('interactive')
    await readZCodeInteractiveCapability(desktopInvocation)
    await readZCodeInteractiveCapability(standalone)

    expect(mocks.runProcess).toHaveBeenCalledTimes(2)
  })
})
