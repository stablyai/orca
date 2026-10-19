import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { DRAIN_APPLY_INTERRUPTION_JS } from './legacy-wsl-runtime-auth-drain-interruption-source'

type CensusResult = {
  status: number | null
  stdout?: string
  signal?: string
  error?: Error
}

function fixture(rows: CensusResult[], ownedPid = '100') {
  const kill = vi.fn()
  const census = vi.fn()
  for (const row of rows) {
    census.mockReturnValueOnce(row)
  }
  const context = {
    process: { pid: 300, env: { ORCA_DRAIN_APPLY_PID: ownedPid }, kill },
    require: () => ({ spawnSync: census })
  }
  return {
    kill,
    census,
    interrupt: (depth = 2) =>
      runInNewContext(`${DRAIN_APPLY_INTERRUPTION_JS}\ninterruptDrainApply(${depth})`, context)
  }
}

describe('owned drain interruption', () => {
  it.each([1, 2])('signals only the owned apply shell at ancestor depth %s', (depth) => {
    const rows = depth === 1 ? ['100'] : ['200', '100']
    const target = fixture(rows.map((stdout) => ({ status: 0, stdout })))
    target.interrupt(depth)
    expect(target.kill).toHaveBeenCalledExactlyOnceWith(100, 'SIGKILL')
    expect(target.census.mock.calls.map(([, args]) => args)).toEqual(
      depth === 1
        ? [['-o', 'ppid=', '-p', '300']]
        : [
            ['-o', 'ppid=', '-p', '300'],
            ['-o', 'ppid=', '-p', '200']
          ]
    )
  })

  it.each([
    { status: 0, stdout: '' },
    { status: 0, stdout: ' \n' },
    { status: 0, stdout: '0' },
    { status: 0, stdout: '-1' },
    { status: 0, stdout: '1' },
    { status: 0, stdout: '9007199254740992' },
    { status: 0, stdout: '100\n200' },
    { status: 1, stdout: '100' },
    { status: null, stdout: '100', signal: 'SIGTERM' },
    { status: 0, stdout: '100', error: new Error('census failed') },
    { status: 0 }
  ])('refuses an invalid census without sending a signal: %j', (row) => {
    const target = fixture([{ status: 0, stdout: '200' }, row])
    expect(() => target.interrupt()).toThrow()
    expect(target.kill).not.toHaveBeenCalled()
  })

  it('refuses a valid ancestor that belongs to another process', () => {
    const target = fixture([
      { status: 0, stdout: '200' },
      { status: 0, stdout: '99' }
    ])
    expect(() => target.interrupt()).toThrow('Apply ancestor is not owned')
    expect(target.kill).not.toHaveBeenCalled()
  })

  it.each(['', '0', '-1', '1', '300', '9007199254740992'])(
    'refuses an invalid owned shell PID %j before running the census',
    (pid) => {
      const target = fixture([], pid)
      expect(() => target.interrupt()).toThrow()
      expect(target.census).not.toHaveBeenCalled()
      expect(target.kill).not.toHaveBeenCalled()
    }
  )
})
