import { afterEach, describe, expect, it, vi } from 'vitest'
import { forkWslTranscriptFsProcess } from './wsl-transcript-fs-process-spawn'

const fork = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ fork }))
vi.mock('node:fs', () => ({ existsSync: () => true }))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('WSL transcript reader runtime isolation', () => {
  it.each(['darwin', 'linux', 'win32'])('isolates owned Bun reads on %s', (platform) => {
    vi.stubGlobal('process', {
      ...process,
      platform,
      versions: { ...process.versions, bun: '1.4.2' }
    })
    forkWslTranscriptFsProcess()
    expect(fork).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        execArgv: [
          '--no-env-file',
          platform === 'win32' ? '--config=NUL' : '--config=/dev/null',
          '--no-install'
        ]
      })
    )
  })

  it('preserves the Node and Electron launch policy', () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: undefined } })
    forkWslTranscriptFsProcess()
    expect(fork).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        execArgv: [],
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' })
      })
    )
  })
})
