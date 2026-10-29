import { expect, it, vi } from 'vitest'
import { FilesystemHostCapacity } from './filesystem-host-capacity'
import { FilesystemHostProcessError } from './filesystem-host-process-error'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'
import type { FilesystemHostProcessFactory } from './filesystem-host-supervisor-options'

it('keeps healthy background capacity across unique unreaped classifiers until physical exit', async () => {
  const capacity = new FilesystemHostCapacity(8)
  const classifierExits: (() => void)[] = []
  const healthyRetire = vi.fn()
  const startProcess: FilesystemHostProcessFactory = async (options) => {
    let classification = false
    return {
      invoke: async (operation) => {
        if (operation.kind === 'classify-path') {
          classification = true
          classifierExits.push(() => options.onPhysicalExit?.())
          throw new FilesystemHostProcessError('deadline', 'Simulated uninterruptible stat')
        }
        return { kind: 'canonicalize-path', canonicalPath: operation.path }
      },
      retire: async () => {
        if (classification) return false
        healthyRetire()
        options.onPhysicalExit?.()
        return true
      }
    }
  }
  const supervisors = [0, 1].map(() => new FilesystemHostSupervisor({
    entryPath: 'unused', capacity, startProcess
  }))
  const [catalog, healthy] = supervisors
  const read = (path: string, admission: 'background' | 'foreground' = 'background') => healthy.dispatch({
    operationId: path,
    operation: { kind: 'canonicalize-path', path },
    executionHost: 'native',
    storageClass: 'workspace',
    admission,
    deadlineMs: 1000
  })
  const classify = (index: number) => supervisors[index % 2].dispatch({
    operationId: `classifier-${index}`,
    operation: { kind: 'classify-path', path: `/stalled/repo-${index}` },
    executionHost: 'native',
    storageClass: 'workspace',
    admission: 'background',
    deadlineMs: 1000
  })
  for (const mount of ['warm', 'replacement', 'other', 'foreground']) {
    healthy.publishFailureDomain({ executionHost: 'native', prefix: `/${mount}`, mountId: mount })
  }
  try {
    await read('/warm/file')
    for (let index = 0; index < 7; index++) {
      await expect(classify(index)).rejects.toMatchObject({ code: index < 4 ? 'deadline' : 'capacity' })
    }
    expect(classifierExits).toHaveLength(4)
    expect(capacity.reservedCount).toBe(5)
    expect(healthyRetire).not.toHaveBeenCalled()
    await expect(read('/warm/file')).resolves.toMatchObject({ canonicalPath: '/warm/file' })
    await expect(read('/replacement/file')).resolves.toMatchObject({ canonicalPath: '/replacement/file' })
    await read('/other/file')
    expect(capacity.reservedCount).toBe(7)
    await read('/foreground/file', 'foreground')
    expect(capacity.reservedCount).toBe(8)
    healthy.removeFailureDomain({ executionHost: 'native', prefix: '/other' })
    await vi.waitFor(() => expect(capacity.reservedCount).toBe(7))
    await expect(classify(7)).rejects.toMatchObject({ code: 'capacity' })

    classifierExits[0]()
    classifierExits[0]()
    expect(capacity.reservedCount).toBe(6)
    await expect(classify(8)).rejects.toMatchObject({ code: 'deadline' })
    expect(classifierExits).toHaveLength(5)
    expect(capacity.reservedCount).toBe(7)
  } finally {
    for (const exit of classifierExits) exit()
    await Promise.all(supervisors.map((supervisor) => supervisor.dispose()))
  }
  expect(capacity.reservedCount).toBe(0)
  expect(catalog.health().didNotExitDomains).toBe(0)
})
