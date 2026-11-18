import { describe, expect, it } from 'vitest'
import { parsePsOutput } from './process-index'
import {
  parseTypeperfProcessOutput,
  parseWindowsProcessSample
} from './windows-process-sample-parsing'

describe('process sweep executable names', () => {
  it('keeps only the basename of ps comm, including paths with spaces', () => {
    const rows = parsePsOutput(
      '  10     1   0.0  2048 /Users/me/Library/My Tools/claude\n  11    10  1.5   512 node\n',
      true
    )
    expect(rows.map((row) => row.name)).toEqual(['claude', 'node'])
  })

  it('reads the CIM Name column and typeperf instance names', () => {
    const cim = parseWindowsProcessSample(
      '42\t7\t1048576\t10\t20\t638000000000000000\t2048\tclaude.exe\n'
    )
    expect(cim.rows[0]).toMatchObject({ pid: 42, privateMemory: 2048 * 1024, name: 'claude' })

    const typeperf = parseTypeperfProcessOutput(
      [
        '"(PDH-CSV 4.0)","\\\\H\\Process(node#1)\\ID Process","\\\\H\\Process(node#1)\\Creating Process ID","\\\\H\\Process(node#1)\\Working Set","\\\\H\\Process(node#1)\\Private Bytes"',
        '"11/17/2026 10:00:00.000","42","7","1048576","2097152"'
      ].join('\n'),
      true
    )
    expect(typeperf).toEqual([
      { pid: 42, ppid: 7, cpu: 0, memory: 1048576, privateMemory: 2097152, name: 'node' }
    ])
  })
})
