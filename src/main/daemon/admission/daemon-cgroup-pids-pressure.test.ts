import { describe, expect, it } from 'vitest'
import { CgroupPidsPressure, readCgroupPidsUsage } from './daemon-cgroup-pids-pressure'

describe('CgroupPidsPressure', () => {
  it('goes critical at 90% of the tightest ancestor limit and recovers below 80%', async () => {
    const files: Record<string, string> = {
      '/proc/self/cgroup': '0::/a/b\n',
      '/sys/fs/cgroup/a/b/pids.max': 'max\n',
      '/sys/fs/cgroup/a/b/pids.current': '10\n',
      '/sys/fs/cgroup/a/pids.max': '200\n',
      '/sys/fs/cgroup/a/pids.current': '100\n'
    }
    const readText = async (path: string): Promise<string> => {
      const text = files[path]
      if (text === undefined) {
        throw new Error('ENOENT')
      }
      return text
    }
    const pressure = new CgroupPidsPressure({
      log: () => {},
      onLevelChanged: () => {},
      read: () => readCgroupPidsUsage(readText, 'linux'),
      now: () => 0
    })
    const levelWith = async (current: number): Promise<string> => {
      files['/sys/fs/cgroup/a/pids.current'] = `${current}\n`
      await pressure.refresh()
      return pressure.level
    }

    expect(await levelWith(100)).toBe('ok')
    expect(await levelWith(180)).toBe('critical')
    expect(await levelWith(165)).toBe('critical')
    expect(await levelWith(159)).toBe('ok')
  })

  it('reads the pids controller on a cgroup v1 host', async () => {
    const files: Record<string, string> = {
      '/proc/self/cgroup':
        '12:pids:/docker/abc\n11:memory:/docker/abc\n1:name=systemd:/docker/abc\n',
      '/sys/fs/cgroup/pids/docker/abc/pids.max': '100\n',
      '/sys/fs/cgroup/pids/docker/abc/pids.current': '95\n'
    }
    const readText = async (path: string): Promise<string> => {
      const text = files[path]
      if (text === undefined) {
        throw new Error('ENOENT')
      }
      return text
    }

    expect(await readCgroupPidsUsage(readText, 'linux')).toEqual({
      current: 95,
      max: 100,
      cgroup: '/docker/abc'
    })
  })
})
