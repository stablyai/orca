import { afterEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { readPosixProcessRow } from './provider-process-row-read'
import { setLibprocAddonForTests } from '../../shared/process-observation/darwin/libproc-addon'
import { resetNativeReadsForTests } from '../../shared/process-observation/darwin/libproc-native-reads'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('./provider-process-supervisor', () => ({ resolveProviderExecPath: () => '/helper' }))

const result = {
  code: 0,
  signal: null,
  stdout: '4242 777 4242 1700000000 123456\n',
  stderr: '',
  timedOut: false,
  outputTruncated: false
}

afterEach(() => {
  setLibprocAddonForTests(undefined)
  resetNativeReadsForTests()
  vi.resetAllMocks()
})

it('recovers exact recorded births while the addon rejects without rounding within a second', async () => {
  setLibprocAddonForTests({
    readProcessTable: async () => {
      throw new Error('unavailable')
    }
  })
  vi.mocked(runProcess)
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce({
      ...result,
      stdout: '4242 777 4242 1700000000 123457\n'
    })
  await expect(readPosixProcessRow(4242, 'microsecond', 'darwin')).resolves.toEqual({
    pid: 4242,
    ppid: 777,
    pgid: 4242,
    startedAt: 'microsecond:1700000000:123456',
    startResolution: 'microsecond'
  })
  await expect(readPosixProcessRow(4242, 'microsecond', 'darwin')).resolves.toEqual({
    pid: 4242,
    ppid: 777,
    pgid: 4242,
    startedAt: 'microsecond:1700000000:123457',
    startResolution: 'microsecond'
  })
})

it('distinguishes proven absence from incomplete or mismatched helper observations', async () => {
  setLibprocAddonForTests(null)
  vi.mocked(runProcess).mockResolvedValueOnce({ ...result, stdout: 'absent\n' })
  await expect(readPosixProcessRow(4242, 'microsecond', 'darwin')).resolves.toBeNull()
  for (const override of [
    { code: 1, stdout: '' },
    { timedOut: true },
    { outputTruncated: true },
    { stdout: '4243 777 4242 1700000000 123456\n' },
    { stdout: '4242 777 4242 1700000000 1000000\n' }
  ]) {
    vi.mocked(runProcess).mockResolvedValueOnce({ ...result, ...override })
    await expect(readPosixProcessRow(4242, 'microsecond', 'darwin')).resolves.toBe('unverifiable')
  }
})
