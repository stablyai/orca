import { describe, expect, it } from 'vitest'
import { assertWindowsProcessTreeIdentity } from './windows-process-tree-capability.cjs'

describe('windows-process-tree native capability', () => {
  it('requires the API patch as well as a loadable module', async () => {
    await expect(assertWindowsProcessTreeIdentity({})).rejects.toThrow('API patch')
  })
  it('requests command line and creation time for the probe process', async () => {
    const api = {
      ProcessDataFlag: { CreationTime: 4 },
      getProcessList(pid, callback, flags) {
        expect(pid).toBe(42)
        expect(flags).toBe(6)
        callback([{ pid: 42, creationTimeMs: 123 }])
      }
    }
    await expect(assertWindowsProcessTreeIdentity(api, { pid: 42 })).resolves.toBe(123)
  })
  it.each([undefined, 0, -1, Number.NaN, Infinity, '123'])(
    'rejects an old or invalid native timestamp: %s',
    async (creationTimeMs) => {
      const api = {
        ProcessDataFlag: { CreationTime: 4 },
        getProcessList(pid, callback) {
          callback([{ pid, creationTimeMs }])
        }
      }
      await expect(assertWindowsProcessTreeIdentity(api)).rejects.toThrow('positive creationTimeMs')
    }
  )
  it.each([[], undefined, [{ pid: -1, creationTimeMs: 123 }]])(
    'rejects a missing self row',
    async (rows) => {
      const api = {
        ProcessDataFlag: { CreationTime: 4 },
        getProcessList(_pid, callback) {
          callback(rows)
        }
      }
      await expect(assertWindowsProcessTreeIdentity(api)).rejects.toThrow('own process')
    }
  )
  it('bounds a stalled callback', async () => {
    await expect(
      assertWindowsProcessTreeIdentity(
        {
          ProcessDataFlag: { CreationTime: 4 },
          getProcessList() {}
        },
        { timeoutMs: 10 }
      )
    ).rejects.toThrow('timed out')
  })
  it('reports a native invocation error', async () => {
    await expect(
      assertWindowsProcessTreeIdentity({
        ProcessDataFlag: { CreationTime: 4 },
        getProcessList() {
          throw new Error('native failure')
        }
      })
    ).rejects.toThrow('native failure')
  })
})
