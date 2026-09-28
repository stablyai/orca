import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { WSL_DAEMON_START_SCRIPT } from './wsl-daemon-start-script'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const serverBuildId = hash(
  JSON.stringify({
    runtime: hash('runtime'),
    files: [{ name: 'daemon-entry.js', sha256: hash('entry') }]
  })
)

it.each(['live', 'EACCES', 'timeout', 'ENOENT', 'ECONNREFUSED', 'changed-artifact'])(
  'launches only after verified absent %s contact',
  async (contact) => {
    const absent = contact === 'ENOENT' || contact === 'ECONNREFUSED'
    const spawn = vi.fn(() => ({ unref: vi.fn() }))
    let contacts = 0
    const processState = {
      argv: [
        'bun',
        JSON.stringify({
          serverBuildId,
          userId: '1000',
          home: '/home/u',
          runtime: '/bun',
          entry: '/daemon.js',
          socket: '/s',
          tokenPath: '/t'
        })
      ],
      env: { HOME: '/home/u' },
      getuid: () => 1000,
      exitCode: 0
    }
    const require = (module: string) => {
      if (module === 'node:crypto') {
        return { createHash }
      }
      if (module === 'node:fs') {
        return {
          lstatSync: () => ({
            isFile: () => true,
            isSymbolicLink: () => false,
            uid: 1000,
            mode: 0o700
          }),
          readFileSync: (file: string) =>
            file === '/bun' ? 'runtime' : contact === 'changed-artifact' ? 'changed' : 'entry'
        }
      }
      return {
        createConnection: () => {
          const outcome =
            contacts++ > 0 ? 'live' : contact === 'changed-artifact' ? 'ENOENT' : contact
          const socket = new EventEmitter()
          Object.assign(socket, { setTimeout: vi.fn(), destroy: vi.fn() })
          queueMicrotask(() => {
            if (outcome === 'live') {
              socket.emit('connect')
            } else if (outcome === 'timeout') {
              socket.emit('timeout')
            } else {
              socket.emit('error', Object.assign(new Error(outcome), { code: outcome }))
            }
          })
          return socket
        }
      }
    }
    await runInNewContext(WSL_DAEMON_START_SCRIPT, {
      require,
      process: processState,
      Bun: { spawn },
      console: { log: vi.fn(), error: vi.fn() },
      setTimeout
    })
    expect(spawn).toHaveBeenCalledTimes(absent ? 1 : 0)
    if (absent) {
      expect(spawn).toHaveBeenCalledWith(
        [
          '/bun',
          '--no-env-file',
          '--config=/dev/null',
          '--no-install',
          '/daemon.js',
          '--socket',
          '/s',
          '--token',
          '/t'
        ],
        expect.objectContaining({ detached: true })
      )
    }
    expect(processState.exitCode).toBe(contact === 'live' || absent ? 0 : 1)
  }
)

it('rejects a changed user before touching the endpoint', () => {
  const require = vi.fn()
  expect(() =>
    runInNewContext(WSL_DAEMON_START_SCRIPT, {
      require,
      process: {
        argv: ['bun', JSON.stringify({ userId: '1000', home: '/home/u' })],
        getuid: () => 1001,
        env: { HOME: '/home/u' }
      }
    })
  ).toThrow('owner changed')
  expect(require).toHaveBeenCalledTimes(1)
})
