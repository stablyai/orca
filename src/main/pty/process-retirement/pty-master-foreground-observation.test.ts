import type * as ForegroundModule from './terminal-process-rows'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { observePtyForeground, readPtyForegroundGroup } from './pty-master-foreground-observation'
const mocks = vi.hoisted(() => ({ rows: vi.fn(), tty: vi.fn(), ps: vi.fn() }))
vi.mock('./terminal-process-rows', async (importOriginal) => ({
  ...(await importOriginal<typeof ForegroundModule>()),
  readPtyTerminalRows: mocks.rows,
  readTerminalTty: mocks.tty,
  readTerminalPs: mocks.ps
}))
const row = (command: string, pid = 201, pgid = 200) => ({
  pid,
  ppid: 100,
  pgid,
  tpgid: 200,
  stat: 'S+',
  command
})
const proc = () => ({
  pid: 100,
  fd: 9,
  ptsName: '/dev/pts/5',
  getForegroundProcessGroup: vi.fn((): number | null | undefined => 200)
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.rows.mockResolvedValue([row('claude')])
  mocks.tty.mockResolvedValue('pts/5')
  mocks.ps.mockResolvedValue('200 pts/5')
})
describe('physical PTY observations', () => {
  it('never queries a retired/reused fd or rescues a supported failure with a cached name', async () => {
    const owner = proc()
    owner.fd = -1
    expect(await observePtyForeground(owner, () => true)).toMatchObject({ verdict: 'unverifiable' })
    expect(owner.getForegroundProcessGroup).not.toHaveBeenCalled()
    owner.fd = 9
    owner.getForegroundProcessGroup.mockReturnValue(null)
    expect(await observePtyForeground(owner, () => true)).toMatchObject({
      verdict: 'unverifiable',
      reason: 'master_unavailable'
    })
    expect(mocks.rows).not.toHaveBeenCalled()
  })
  it('discards late results from a replaced session', async () => {
    let current = true
    mocks.rows.mockImplementation(async () => {
      current = false
      return [row('claude')]
    })
    expect(await observePtyForeground(proc(), () => current)).toMatchObject({
      verdict: 'unverifiable',
      reason: 'session_changed'
    })
  })

  it('supports older native images with fresh PTY-matched root proof', async () => {
    const owner = proc()
    owner.getForegroundProcessGroup.mockReturnValue(undefined)
    mocks.rows.mockResolvedValue([row('zsh', 100, 100), row('claude')])
    expect(readPtyForegroundGroup(owner)).toBeUndefined()
    expect(await observePtyForeground(owner, () => true)).toMatchObject({
      verdict: 'observed',
      source: 'posix-process-table'
    })
    mocks.tty.mockResolvedValue('pts/6')
    expect(await observePtyForeground(owner, () => true)).toMatchObject({ verdict: 'unverifiable' })
  })
})
