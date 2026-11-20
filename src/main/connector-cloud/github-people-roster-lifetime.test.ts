// The roster slot on the real gh runner: spawn and process-tree termination are faked, nothing else.
import type { ChildProcess } from 'node:child_process'
import { createFakeSpawnedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { groupExists, spawnMock, signalMock, forceMock } = vi.hoisted(() => ({
  groupExists: vi.fn(() => true),
  spawnMock: vi.fn(),
  signalMock: vi.fn(),
  forceMock: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  processGroupExists: groupExists,
  signalProcessTree: signalMock,
  forceTerminateProcessTree: forceMock
}))
vi.mock('../ipc/command-path/command-path-resolver', () => ({
  resolveSelectedLocalCommand: (command: string) => command
}))

import { GitHubPeopleRosters, ROSTER_TIMEOUT_MS } from './github-people-roster'

function child(pid: number): ChildProcess {
  const value = createFakeSpawnedChild()
  Object.defineProperty(value, 'pid', { value: pid })
  value.kill = vi.fn(() => false)
  return value
}
function close(value: ChildProcess, code = 0, stdout = ''): void {
  value.stdout?.emit('data', Buffer.from(stdout))
  value.emit('exit', code, null)
  groupExists.mockReturnValue(false)
  value.emit('close', code, null)
}
const repos = (...names: string[]) => ({ repositories: names, owners: [], more: false })

describe('the roster slot on the real gh runner', () => {
  beforeEach(() => {
    groupExists.mockReturnValue(true)
    vi.useFakeTimers()
    spawnMock.mockReset()
    signalMock.mockReset().mockResolvedValue(false)
    forceMock.mockReset().mockResolvedValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs one child, kills it at the deadline, and starts the next only once it is gone', async () => {
    const first = child(11)
    const second = child(12)
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const rosters = new GitHubPeopleRosters()
    const slow = rosters.read(repos('a/b'))
    let answered = false
    void slow.then(() => {
      answered = true
    })
    const next = rosters.read(repos('c/d'))
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnMock).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(ROSTER_TIMEOUT_MS)
    expect(signalMock).toHaveBeenCalled()
    // The kill isn't confirmed (the process group still exists): no second child, however long.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(spawnMock).toHaveBeenCalledOnce()
    // ...yet the caller already has its answer: the slot's custody isn't the caller's wait.
    expect(answered).toBe(true)

    expect(await slow).toEqual({ status: 'unavailable' })
    close(first, 1)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    close(
      second,
      0,
      JSON.stringify({ data: { r0: { assignableUsers: { totalCount: 0, nodes: [] } } } })
    )
    await vi.advanceTimersByTimeAsync(0)
    expect((await next).status).toBe('read')
  })
})
