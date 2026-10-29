import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { FilesystemHostProcess } from './filesystem-host-process'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'

it('retains one failed pre-ready child per domain until physical exit, preserving healthy capacity', async () => {
  const children: EventEmitter[] = []
  let now = 0
  const supervisor = new FilesystemHostSupervisor({
    entryPath: 'unused',
    maximumChildren: 3,
    now: () => now,
    breakerRecoveryDelayMs: 1,
    startProcess: async (options) => {
      if (children.length) {
        return {
          invoke: async (operation) => ({
            kind: 'canonicalize-path',
            canonicalPath: operation.path
          }),
          retire: async () => {
            options.onPhysicalExit?.()
            return true
          }
        }
      }
      return FilesystemHostProcess.start({
        ...options,
        readyTimeoutMs: 5,
        exitDeadlineMs: 5,
        hardKillDelayMs: 1,
        spawn: () => {
          const child = Object.assign(new EventEmitter(), {
            connected: true,
            kill: vi.fn(() => true)
          })
          children.push(child)
          return child as unknown as ChildProcess
        }
      })
    }
  })
  for (const mount of ['bad', 'good']) {
    supervisor.publishFailureDomain({
      executionHost: 'native',
      prefix: `/${mount}`,
      mountId: mount
    })
  }
  const dispatch = (path: string) =>
    supervisor.dispatch({
      operationId: path,
      operation: { kind: 'canonicalize-path', path },
      admission: 'foreground',
      executionHost: 'native',
      storageClass: 'workspace',
      deadlineMs: 1000
    })
  await expect(dispatch('/bad/a')).rejects.toMatchObject({ code: 'deadline' })
  for (let retry = 0; retry < 3; retry++) {
    now += 10
    await expect(dispatch('/bad/a')).rejects.toMatchObject({ code: 'unreaped' })
  }
  expect(supervisor.health()).toMatchObject({
    physicalChildren: 1,
    abandonedChildren: 1,
    didNotExitDomains: 1
  })
  await expect(dispatch('/good/a')).resolves.toMatchObject({ canonicalPath: '/good/a' })
  children[0].emit('exit', null, 'SIGKILL')
  expect(supervisor.health()).toMatchObject({
    physicalChildren: 1,
    abandonedChildren: 0,
    didNotExitDomains: 0
  })
  now += 10
  await expect(dispatch('/bad/a')).resolves.toMatchObject({ canonicalPath: '/bad/a' })
  await supervisor.dispose()
})
