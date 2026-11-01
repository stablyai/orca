import { describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('node:os', () => ({ platform: () => 'darwin' }))

import {
  listServeSimHelperProcessesForDevice,
  parseServeSimHelperProcesses
} from './serve-sim-helper-processes'

describe('parseServeSimHelperProcesses', () => {
  it('returns legacy serve-sim-bin helper processes from ps output', () => {
    const psOutput = `
      101 /Applications/serve-sim/bin/serve-sim-bin UDID-1 --port 3100
      102 /Applications/serve-sim/bin/serve-sim UDID-1 --port 3100
      103 /tmp/serve-sim-binary UDID-1 --port 3100
      104 node /Applications/serve-sim/bin/serve-sim-bin UDID-2 --port 3101
    `

    expect(parseServeSimHelperProcesses(psOutput)).toEqual([
      {
        pid: 101,
        command: '/Applications/serve-sim/bin/serve-sim-bin UDID-1 --port 3100'
      },
      {
        pid: 104,
        command: 'node /Applications/serve-sim/bin/serve-sim-bin UDID-2 --port 3101'
      }
    ])
  })

  it('returns node-hosted serve-sim helpers and skips one-shot serve-sim commands', () => {
    const runtime = '/Users/me/Library/Application Support/Orca/serve-sim-runtime/1.4.0'
    const psOutput = `
      301 /Applications/Orca.app/Contents/MacOS/Orca ${runtime}/dist/serve-sim.js UDID-1 --port 3100 --host 127.0.0.1 --exit-on-simulator-shutdown
      302 /Applications/Orca.app/Contents/MacOS/Orca ${runtime}/dist/serve-sim.js tap 0.5 0.5 -d UDID-1
      303 /Applications/Orca.app/Contents/MacOS/Orca ${runtime}/dist/serve-sim.js --detach -q UDID-1
      304 /usr/local/bin/serve-sim UDID-2 --port 3101 --host 127.0.0.1 --exit-on-simulator-shutdown
      305 node /tmp/not-serve-sim.js UDID-3 --exit-on-simulator-shutdown
    `

    expect(parseServeSimHelperProcesses(psOutput)).toEqual([
      {
        pid: 301,
        command: `/Applications/Orca.app/Contents/MacOS/Orca ${runtime}/dist/serve-sim.js UDID-1 --port 3100 --host 127.0.0.1 --exit-on-simulator-shutdown`
      },
      {
        pid: 304,
        command:
          '/usr/local/bin/serve-sim UDID-2 --port 3101 --host 127.0.0.1 --exit-on-simulator-shutdown'
      }
    ])
  })

  it('scans ps output without line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    try {
      const helpers = parseServeSimHelperProcesses(
        '201 /Applications/serve-sim/bin/serve-sim-bin UDID-1 --port 3100\r\n'
      )
      const usedOutputSplit = splitSpy.mock.calls.some(([separator]) => {
        const pattern = separator as unknown
        return (
          pattern === '\n' ||
          (pattern instanceof RegExp && (pattern.source === '\\r?\\n' || pattern.source === '\\s+'))
        )
      })
      expect(helpers).toHaveLength(1)
      expect(usedOutputSplit).toBe(false)
    } finally {
      splitSpy.mockRestore()
    }
  })
})

describe('listServeSimHelperProcessesForDevice', () => {
  it('uses the known helper PID instead of capturing the whole process table', async () => {
    execFileMock.mockImplementationOnce((_command, args, _options, callback) => {
      expect(args).toEqual(['-p', '123', '-o', 'pid=,command='])
      callback(
        null,
        Buffer.from(' 123 /Applications/serve-sim/bin/serve-sim-bin UDID-1 --port 3100\n'),
        Buffer.from('')
      )
    })

    await expect(
      listServeSimHelperProcessesForDevice('UDID-1', {
        helperPid: 123
      })
    ).resolves.toEqual([
      {
        pid: 123,
        command: '/Applications/serve-sim/bin/serve-sim-bin UDID-1 --port 3100'
      }
    ])
  })

  it('treats a missing known PID as an absent helper', async () => {
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(Object.assign(new Error('ps exited with code 1'), { code: 1 }), Buffer.from(''), '')
    })

    await expect(
      listServeSimHelperProcessesForDevice('UDID-1', { helperPid: 123 })
    ).resolves.toEqual([])
  })

  it('propagates process enumeration failures instead of treating them as no helper', async () => {
    const error = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    })
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(error, Buffer.from(''), Buffer.from(''))
    })

    await expect(
      listServeSimHelperProcessesForDevice('UDID-1', { includeOrphaned: true })
    ).rejects.toBe(error)
  })
})
