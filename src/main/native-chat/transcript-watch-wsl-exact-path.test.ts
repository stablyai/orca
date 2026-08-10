import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsModule from 'node:fs'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const ROLLOUT_LINUX =
  '/home/ada/.local/share/orca/codex-runtime-home/home/sessions/2026/07/24/rollout-wsl.jsonl'
const ROLLOUT_UNC =
  '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\24\\rollout-wsl.jsonl'

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  resolve: vi.fn()
}))

vi.mock('./session-file-resolver', () => ({
  resolveSessionFilePath: mocks.resolve
}))
vi.mock('./transcript-watch-engine', () => ({
  getActiveNativeChatWatcherCount: vi.fn(() => 0),
  installTranscriptWatcher: mocks.install
}))
vi.mock('../wsl', () => ({
  listWslDistrosAsync: vi.fn(async () => ['Ubuntu']),
  getWslHomeAsync: vi.fn(async () => UBUNTU_HOME)
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsModule>()
  return {
    ...actual,
    existsSync: (path: string) => path === ROLLOUT_UNC || actual.existsSync(path)
  }
})

import { resetHostReadableTranscriptPathCacheForTests } from './host-readable-transcript-path'
import { subscribeNativeChatTranscript } from './transcript-watch'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('exact hook path install on a Windows host with WSL (#10326)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHostReadableTranscriptPathCacheForTests()
    mocks.install.mockReset().mockReturnValue(null)
    mocks.resolve.mockReset().mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    setPlatform(realPlatform)
  })

  it('installs the watcher on the WSL UNC twin of the guest transcript path', async () => {
    setPlatform('win32')
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'wsl-sess',
      transcriptPath: ROLLOUT_LINUX,
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(mocks.install).toHaveBeenCalledWith(ROLLOUT_UNC, expect.anything(), expect.anything())
    expect(mocks.install.mock.calls.every(([path]) => path !== ROLLOUT_LINUX)).toBe(true)
    subscription.unsubscribe()
  })

  it('passes the raw path through untouched off Windows', async () => {
    setPlatform('darwin')
    const subscription = await subscribeNativeChatTranscript({
      agent: 'codex',
      sessionId: 'wsl-sess',
      transcriptPath: ROLLOUT_LINUX,
      resolvePollIntervalMs: 10,
      onAppend: () => {}
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(mocks.install).toHaveBeenCalledWith(ROLLOUT_LINUX, expect.anything(), expect.anything())
    subscription.unsubscribe()
  })
})
