import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  localLaunchArtifactsWritable,
  noteLaunchArtifactRefusal
} from './local-launch-artifact-directory'
import { WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS } from './wsl-launch-directory-resolution'

vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: vi.fn() }))

const REFUSAL = new Error(
  'Orca could not write it (ENOSPC), so the agent was not started. [launch_file_unavailable]'
)

// Why: a host that cannot write its temp folder neither stages a line nor writes a launch file, so
// the next launch is planned without either rather than refused again.
describe('whether this machine can write its staging folder', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves this machine’s folder alone when the refused write was into a WSL distro', () => {
    noteLaunchArtifactRefusal({ wslDistro: 'Ubuntu', wslLaunchDirectory: undefined }, REFUSAL)
    expect(localLaunchArtifactsWritable()).toBe(true)
  })

  it('is yes until a write there is refused, then again after the failure TTL', () => {
    vi.useFakeTimers()
    expect(localLaunchArtifactsWritable()).toBe(true)
    noteLaunchArtifactRefusal({ wslDistro: null, wslLaunchDirectory: undefined }, new Error('EIO'))
    expect(localLaunchArtifactsWritable()).toBe(true)
    noteLaunchArtifactRefusal({ wslDistro: null, wslLaunchDirectory: undefined }, REFUSAL)
    expect(localLaunchArtifactsWritable()).toBe(false)
    vi.advanceTimersByTime(WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS)
    expect(localLaunchArtifactsWritable()).toBe(true)
  })
})
