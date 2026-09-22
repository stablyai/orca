import { describe, expect, it, vi } from 'vitest'

async function loadWindowsProcessSampleParsing() {
  vi.resetModules()
  return await import('./windows-process-sample-parsing')
}

describe('parseWindowsProcessOutput', () => {
  it('parses tab-delimited CIM process rows', async () => {
    const { parseWindowsProcessOutput } = await loadWindowsProcessSampleParsing()

    expect(parseWindowsProcessOutput('100\t1\t2048\r\n200\t100\t1024')).toEqual([
      { pid: 100, ppid: 1, cpu: 0, memory: 2048 },
      { pid: 200, ppid: 100, cpu: 0, memory: 1024 }
    ])
  })

  it('skips malformed rows and clamps invalid memory to zero', async () => {
    const { parseWindowsProcessOutput } = await loadWindowsProcessSampleParsing()

    expect(
      parseWindowsProcessOutput(
        [
          'garbage',
          'abc\t1\t100',
          '10\txyz\t100',
          '0\t0\t100',
          '-5\t0\t100',
          '30\t-1\t100',
          '20\t1\t-50'
        ].join('\n')
      )
    ).toEqual([{ pid: 20, ppid: 1, cpu: 0, memory: 0 }])
  })

  it('reads PageFileUsage kilobytes into committed private bytes', async () => {
    const { parseWindowsProcessOutput } = await loadWindowsProcessSampleParsing()

    // 5,600,000 KB of commit behind a 96 MB working set is the reported shape.
    expect(
      parseWindowsProcessOutput('100\t1\t100663296\t0\t0\t638830000000000000\t5600000')
    ).toEqual([{ pid: 100, ppid: 1, cpu: 0, memory: 100663296, privateMemory: 5600000 * 1024 }])
  })

  it('leaves committed bytes absent when the host omits PageFileUsage', async () => {
    const { parseWindowsProcessOutput } = await loadWindowsProcessSampleParsing()

    const [row] = parseWindowsProcessOutput('100\t1\t2048\t0\t0\t638830000000000000')

    expect(row.privateMemory).toBeUndefined()
    expect(parseWindowsProcessOutput('100\t1\t2048\t0\t0\t1\t')[0].privateMemory).toBeUndefined()
  })

  it('keeps a zero PageFileUsage distinct from an unreported one', async () => {
    const { parseWindowsProcessOutput } = await loadWindowsProcessSampleParsing()

    expect(parseWindowsProcessOutput('4\t0\t2048\t0\t0\t1\t0')[0].privateMemory).toBe(0)
  })

  it('preserves empty CIM field positions instead of shifting CPU ticks into memory', async () => {
    const { parseWindowsProcessOutput } = await loadWindowsProcessSampleParsing()

    expect(parseWindowsProcessOutput('100\t1\t\t200\t300\t638830000000000000')).toEqual([
      { pid: 100, ppid: 1, cpu: 0, memory: 0 }
    ])
  })
})

describe('parseTypeperfProcessOutput', () => {
  it('joins PID, parent PID, and working-set counters by process instance', async () => {
    const { parseTypeperfProcessOutput } = await loadWindowsProcessSampleParsing()
    const stdout = [
      '"(PDH-CSV 4.0)","\\\\HOST\\Process(node)\\ID Process","\\\\HOST\\Process(node#1)\\ID Process","\\\\HOST\\Process(node)\\Creating Process ID","\\\\HOST\\Process(node#1)\\Creating Process ID","\\\\HOST\\Process(node)\\Working Set","\\\\HOST\\Process(node#1)\\Working Set"',
      '"07/15/2026 01:44:54.514","100.000000","200.000000","1.000000","100.000000","2048.000000","4096.000000"'
    ].join('\r\n')

    expect(parseTypeperfProcessOutput(stdout)).toEqual([
      { pid: 100, ppid: 1, cpu: 0, memory: 2048 },
      { pid: 200, ppid: 100, cpu: 0, memory: 4096 }
    ])
  })

  it('joins the Private Bytes counter onto the same process instance', async () => {
    const { parseTypeperfProcessOutput } = await loadWindowsProcessSampleParsing()
    const stdout = [
      '"(PDH-CSV 4.0)","\\\\HOST\\Process(codex)\\ID Process","\\\\HOST\\Process(codex)\\Creating Process ID","\\\\HOST\\Process(codex)\\Working Set","\\\\HOST\\Process(codex)\\Private Bytes"',
      '"07/15/2026 01:44:54.514","100.000000","1.000000","100663296.000000","5734400000.000000"'
    ].join('\r\n')

    expect(parseTypeperfProcessOutput(stdout)).toEqual([
      { pid: 100, ppid: 1, cpu: 0, memory: 100663296, privateMemory: 5734400000 }
    ])
  })

  it('leaves committed bytes absent when the Private Bytes counter is missing', async () => {
    const { parseTypeperfProcessOutput } = await loadWindowsProcessSampleParsing()
    const stdout = [
      '"(PDH-CSV 4.0)","\\\\HOST\\Process(codex)\\ID Process","\\\\HOST\\Process(codex)\\Creating Process ID","\\\\HOST\\Process(codex)\\Working Set"',
      '"time","100.000000","1.000000","2048.000000"'
    ].join('\r\n')

    expect(parseTypeperfProcessOutput(stdout)[0].privateMemory).toBeUndefined()
  })

  it('still parses a busy host once a fourth counter widens every sample line', async () => {
    const { parseTypeperfProcessOutput } = await loadWindowsProcessSampleParsing()
    // 2100 processes x 4 counters overruns a fixed 8192-field cap; the reported
    // MCP fan-out host runs well past 2048 processes.
    const instanceCount = 2100
    const headers = ['"(PDH-CSV 4.0)"']
    const values = ['"time"']
    for (let index = 0; index < instanceCount; index += 1) {
      for (const counter of ['ID Process', 'Creating Process ID', 'Working Set', 'Private Bytes']) {
        headers.push(`"\\\\HOST\\Process(node#${index})\\${counter}"`)
      }
      values.push(`"${1000 + index}"`, '"1"', '"2048"', '"4096"')
    }
    const stdout = [headers.join(','), values.join(',')].join('\r\n')

    const rows = parseTypeperfProcessOutput(stdout)
    expect(rows).toHaveLength(instanceCount)
    expect(rows[instanceCount - 1]).toEqual({
      pid: 1000 + instanceCount - 1,
      ppid: 1,
      cpu: 0,
      memory: 2048,
      privateMemory: 4096
    })
  })

  it('ignores aggregate and incomplete rows and clamps invalid memory', async () => {
    const { parseTypeperfProcessOutput } = await loadWindowsProcessSampleParsing()
    const stdout = [
      '"(PDH-CSV 4.0)","\\\\HOST\\Process(_Total)\\ID Process","\\\\HOST\\Process(cmd)\\ID Process","\\\\HOST\\Process(orphan)\\ID Process","\\\\HOST\\Process(_Total)\\Creating Process ID","\\\\HOST\\Process(cmd)\\Creating Process ID","\\\\HOST\\Process(_Total)\\Working Set","\\\\HOST\\Process(cmd)\\Working Set"',
      '"time","0.000000","100.000000","200.000000","0.000000","1.000000","999999.000000","-1.000000"'
    ].join('\r\n')

    expect(parseTypeperfProcessOutput(stdout)).toEqual([{ pid: 100, ppid: 1, cpu: 0, memory: 0 }])
  })
})
