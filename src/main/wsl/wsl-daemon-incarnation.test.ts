import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { WSL_DAEMON_INCARNATION_SCRIPT } from './wsl-daemon-incarnation'

it.each([
  'same',
  'new-boot',
  'missing-pid',
  'hidden-pid',
  'hidden-EPERM',
  'reused-pid',
  'EACCES',
  'malformed',
  'no-proof'
])('classifies retained guest incarnation: %s', (scenario) => {
  const log = vi.fn()
  const stat = `42 (shell ) with spaces) ${Array.from({ length: 20 }, (_, i) => (i === 19 ? (scenario === 'reused-pid' ? '999' : '123') : '0')).join(' ')}`
  const check = () =>
    runInNewContext(WSL_DAEMON_INCARNATION_SCRIPT, {
      require: () => ({
        readFileSync: (path: string) => {
          if (path.endsWith('boot_id')) {
            return scenario === 'new-boot' ? 'new-boot' : 'original-boot'
          }
          if (['missing-pid', 'hidden-pid', 'hidden-EPERM', 'EACCES'].includes(scenario)) {
            throw Object.assign(new Error('unreadable'), {
              code: scenario === 'EACCES' ? 'EACCES' : 'ENOENT'
            })
          }
          return scenario === 'malformed' ? 'bad stat' : stat
        }
      }),
      process: {
        kill: () => {
          if (scenario !== 'hidden-pid') {
            throw Object.assign(new Error('probe'), {
              code: scenario === 'hidden-EPERM' ? 'EPERM' : 'ESRCH'
            })
          }
        },
        getuid: () => 1000,
        env: { HOME: '/home/u' },
        argv: [
          'bun',
          JSON.stringify({
            userId: '1000',
            home: '/home/u',
            incarnation:
              scenario === 'no-proof'
                ? undefined
                : { pid: 42, linuxStartTicks: '123', bootId: 'original-boot' }
          })
        ]
      },
      console: { log }
    })
  if (['new-boot', 'missing-pid', 'reused-pid'].includes(scenario)) {
    check()
    expect(log).toHaveBeenCalledWith('exited')
  } else {
    expect(check).toThrow()
    expect(log).not.toHaveBeenCalled()
  }
})
