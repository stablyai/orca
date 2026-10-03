import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  resolveCommandOnLocalPathMock,
  resolveCliCommandsMock,
  runProcessMock,
  buildLocalPreflightEnvMock
} = vi.hoisted(() => ({
  resolveCommandOnLocalPathMock: vi.fn(),
  resolveCliCommandsMock: vi.fn(),
  runProcessMock: vi.fn(),
  buildLocalPreflightEnvMock: vi.fn()
}))

vi.mock('../ipc/command-path-resolver', () => ({
  resolveCommandOnLocalPath: resolveCommandOnLocalPathMock
}))
// Why: the probe uses the same install-dir resolver detection uses; mock it so
// the host's real install dirs cannot decide the fallback cases.
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommands: resolveCliCommandsMock
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('../ipc/preflight-local-env', () => ({
  buildLocalPreflightEnv: buildLocalPreflightEnvMock
}))

import {
  detectLocalOpenCodeCliGeneration,
  resetLocalOpenCodeGenerationProbes
} from './opencode-generation-probe'

beforeEach(() => {
  vi.resetAllMocks()
  resetLocalOpenCodeGenerationProbes()
  buildLocalPreflightEnvMock.mockReturnValue({ PATH: '/opt/bin' })
  resolveCommandOnLocalPathMock.mockResolvedValue('/opt/bin/opencode')
  // Default: no install-dir fallback (resolveCliCommands echoes not-found names).
  resolveCliCommandsMock.mockImplementation(
    (commands: readonly string[]) => new Map(commands.map((command) => [command, command]))
  )
  runProcessMock.mockResolvedValue({
    code: 0,
    signal: null,
    stdout: 'opencode v2.0.22\n',
    stderr: '',
    timedOut: false
  })
})

describe('detectLocalOpenCodeCliGeneration', () => {
  it('probes the resolved opencode binary with the preflight environment', async () => {
    await expect(detectLocalOpenCodeCliGeneration()).resolves.toBe('v2')

    expect(resolveCommandOnLocalPathMock).toHaveBeenCalledWith('opencode', {
      env: { PATH: '/opt/bin' }
    })
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/opt/bin/opencode', args: ['--version'] })
    )
  })

  it('falls back to opencode2 when opencode is absent', async () => {
    resolveCommandOnLocalPathMock.mockImplementation(async (command: string) =>
      command === 'opencode2' ? '/opt/bin/opencode2' : null
    )

    await expect(detectLocalOpenCodeCliGeneration()).resolves.toBe('v2')
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/opt/bin/opencode2' })
    )
  })

  it('returns null when neither command resolves', async () => {
    resolveCommandOnLocalPathMock.mockResolvedValue(null)

    await expect(detectLocalOpenCodeCliGeneration()).resolves.toBeNull()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('probes an install-dir-only opencode pair so a genuine v1 is classified', async () => {
    // #24987: on a cold GUI launch detection finds the CLI through install dirs,
    // so the probe must resolve the same binary instead of returning null.
    resolveCommandOnLocalPathMock.mockResolvedValue(null)
    resolveCliCommandsMock.mockReturnValue(
      new Map([
        ['opencode', '/home/tester/.local/bin/opencode'],
        ['opencode2', '/home/tester/.local/bin/opencode2']
      ])
    )
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '1.18.34\n',
      stderr: '',
      timedOut: false
    })

    await expect(detectLocalOpenCodeCliGeneration()).resolves.toBe('v1')
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/home/tester/.local/bin/opencode',
        args: ['--version']
      })
    )
  })

  it('prefers a PATH resolution over an install-dir fallback', async () => {
    resolveCommandOnLocalPathMock.mockResolvedValue('/opt/bin/opencode')
    resolveCliCommandsMock.mockReturnValue(
      new Map([['opencode', '/home/tester/.local/bin/opencode']])
    )

    await detectLocalOpenCodeCliGeneration()

    expect(resolveCliCommandsMock).not.toHaveBeenCalled()
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/opt/bin/opencode' })
    )
  })

  it('spawns nothing when the install-dir resolver echoes a not-found name', async () => {
    // resolveCliCommands does NOT signal not-found; an unresolvable command is
    // echoed back by name. Only an absolute path counts as installed.
    resolveCommandOnLocalPathMock.mockResolvedValue(null)
    resolveCliCommandsMock.mockReturnValue(
      new Map([
        ['opencode', 'opencode'],
        ['opencode2', 'opencode2']
      ])
    )

    await expect(detectLocalOpenCodeCliGeneration()).resolves.toBeNull()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('returns null when the version probe fails without crashing detection', async () => {
    runProcessMock.mockRejectedValue(new Error('spawn failed'))

    await expect(detectLocalOpenCodeCliGeneration()).resolves.toBeNull()
  })

  it('reuses a cached probe for the same resolved binary', async () => {
    await detectLocalOpenCodeCliGeneration()
    await detectLocalOpenCodeCliGeneration()

    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('retries an unknown probe after the short cache expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    runProcessMock.mockRejectedValueOnce(new Error('temporarily unavailable'))
    try {
      expect(await detectLocalOpenCodeCliGeneration()).toBeNull()
      expect(await detectLocalOpenCodeCliGeneration()).toBeNull()
      now.mockReturnValue(6_001)
      runProcessMock.mockResolvedValue({
        code: 0,
        signal: null,
        stdout: '1.18.34\n',
        stderr: '',
        timedOut: false
      })
      expect(await detectLocalOpenCodeCliGeneration()).toBe('v1')
      expect(runProcessMock).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })
})
