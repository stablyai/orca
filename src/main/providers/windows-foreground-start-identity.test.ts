import { __setWindowsProcessTreeLoaderForTests } from '../windows/windows-process-table'
import { resolveAgentForegroundProcessWithAvailability } from './agent-foreground-process'
import { expect, it } from 'vitest'
import { resolveWindowsForegroundIdentity } from './windows-agent-foreground-process'

it('keeps the creation marker of the process that supplied the wrapper name', () => {
  const candidates = [
    { pid: 101, ppid: 100, depth: 1, name: 'omp.exe', command: 'omp.exe', creationTimeMs: 123 },
    { pid: 102, ppid: 101, depth: 2, name: 'pi.exe', command: 'pi.exe', creationTimeMs: 456 }
  ]
  expect(resolveWindowsForegroundIdentity(candidates, 'pi.exe', undefined)).toMatchObject({
    processName: 'omp',
    processId: 101,
    processStartTime: '123'
  })
})

it('carries the cached native snapshot start marker through the provider resolver', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!platform) {
    throw new Error('Missing platform descriptor')
  }
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  __setWindowsProcessTreeLoaderForTests(() => ({
    ProcessDataFlag: { None: 0, CommandLine: 2, CreationTime: 4 },
    getAllProcesses: (callback) =>
      callback([
        { pid: process.pid, ppid: 0, name: 'vitest.exe', commandLine: 'vitest' },
        { pid: 100, ppid: 99, name: 'powershell.exe', commandLine: 'powershell.exe' },
        { pid: 101, ppid: 100, name: 'omp.exe', commandLine: 'omp.exe', creationTimeMs: 123 },
        { pid: 102, ppid: 101, name: 'pi.exe', commandLine: 'pi.exe', creationTimeMs: 456 }
      ])
  }))
  try {
    expect(await resolveAgentForegroundProcessWithAvailability(100, 'pi.exe')).toMatchObject({
      processName: 'omp',
      processId: 101,
      processStartTime: '123'
    })
  } finally {
    __setWindowsProcessTreeLoaderForTests()
    Object.defineProperty(process, 'platform', platform)
  }
})
