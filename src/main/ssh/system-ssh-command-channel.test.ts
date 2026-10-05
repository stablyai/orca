import type * as NodeChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  return { ...actual, spawn: spawnMock }
})

import { spawnSystemSshCommand } from './system-ssh-command'

function createTarget(): SshTarget {
  return {
    id: 'teleport-target',
    label: 'Teleport target',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    proxyCommand: 'tsh ssh root@%h'
  }
}

function createChildProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    kill: vi.fn().mockReturnValue(true)
  })
}

describe('system SSH command channel adapter', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('keeps wrapped direct Teleport channel properties replaceable', () => {
    const child = createChildProcess()
    spawnMock.mockReturnValue(child)
    const channel = spawnSystemSshCommand(createTarget(), 'echo hello')
    const originalClose = channel.close
    const wrappedClose = vi.fn(() => originalClose())

    channel.close = wrappedClose
    channel.close()

    expect(wrappedClose).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(Object.keys(channel)).toEqual(expect.arrayContaining(['stdin', 'stderr', 'close']))
  })
})
