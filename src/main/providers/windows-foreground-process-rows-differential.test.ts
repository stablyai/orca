// The wmic reader's whole claim is that it answers identically to the PowerShell
// reader it displaces. Hand-written fixtures cannot check that: they encode the
// same assumptions as the parser, which is how a blank line inside an agent's
// CommandLine shipped as "correct" until a real process table was tried.
//
// So generate hostile tables instead, render each one BOTH as wmic
// `/format:value` (UTF-16LE, no escaping available) and as PowerShell JSON, and
// hold the two readers against each other:
//
//   Fidelity — with content that cannot forge the framing, the wmic rows must
//   equal the PowerShell rows exactly, command text included.
//   Safety   — with content that CAN forge it, no row may claim a pid that
//   exists in the real table under the wrong parent. That is the property
//   `taskkill /T /F` targeting rests on; a phantom pid is inert, a mis-parented
//   real one is not.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import {
  queryWindowsProcessRowsFresh,
  resetWindowsProcessRowsReaderForTests
} from './windows-foreground-process-rows'

type ExecFileCallback = (err: unknown, result: { stdout: string | Buffer; stderr: string }) => void

type GeneratedProcess = {
  ProcessId: number
  ParentProcessId: number
  Name: string
  CommandLine: string
  ExecutablePath: string
}

/** Deterministic PRNG so a failing table is reproducible from its seed alone. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

// Everything a real command line can contain that looks like wmic's framing.
// `ExecutablePath=` is held back: it is the only property that can advance the
// parser out of CommandLine, so a table without it cannot forge a record.
const NON_FORGING_FRAGMENTS = [
  'ProcessId=4',
  'ParentProcessId=0',
  'Name=lsass.exe',
  'CommandLine=nested',
  '',
  '   ',
  'KEY=value',
  '--flag "quoted arg"',
  "$'multi\\nline'",
  'ünïcödé ✓ 中文',
  '   trailing   ',
  '=leading equals',
  'plain continuation text'
]

/** No padding-only entries: with these, trimming is a no-op and equality is exact. */
const STRICT_FRAGMENTS = NON_FORGING_FRAGMENTS.filter((f) => f.trim() === f && f !== '')

const FORGING_FRAGMENTS = [
  ...NON_FORGING_FRAGMENTS,
  'ExecutablePath=C:/evil.exe',
  // A complete forged tail, the documented residue.
  'ExecutablePath=C:/evil.exe\nName=lsass.exe\nParentProcessId=0\nProcessId=4'
]

function generateTable(
  seed: number,
  fragments: string[],
  options: { multiline?: boolean } = {}
): GeneratedProcess[] {
  const random = makeRandom(seed)
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!
  const count = 3 + Math.floor(random() * 12)
  const usedPids = new Set<number>()
  const rows: GeneratedProcess[] = []
  for (let i = 0; i < count; i += 1) {
    let pid = 4 + Math.floor(random() * 60000)
    while (usedPids.has(pid)) {
      pid += 1
    }
    usedPids.add(pid)
    const pieces = Array.from({ length: Math.floor(random() * 4) }, () => pick(fragments))
    const eol = options.multiline === false ? ' ' : random() < 0.5 ? '\r\n' : '\n'
    const command = [`exe${i} --run`, ...pieces].join(eol)
    rows.push({
      ProcessId: pid,
      ParentProcessId: i === 0 ? 0 : rows[Math.floor(random() * rows.length)]!.ProcessId,
      Name: `proc${i}.exe`,
      CommandLine: random() < 0.1 ? '' : command,
      ExecutablePath: random() < 0.1 ? '' : `C:/apps/proc${i}.exe`
    })
  }
  return rows
}

/** wmic `/format:value`: properties in fixed order, blank line after each record. */
function renderWmicValue(rows: GeneratedProcess[]): Buffer {
  const text = rows
    .map((row) =>
      [
        `CommandLine=${row.CommandLine}`,
        `ExecutablePath=${row.ExecutablePath}`,
        `Name=${row.Name}`,
        `ParentProcessId=${row.ParentProcessId}`,
        `ProcessId=${row.ProcessId}`,
        ''
      ].join('\r\n')
    )
    .join('\r\n')
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

const isWmic = (command: string): boolean => /wmic/i.test(command)

type ReadRow = { pid: number; ppid: number; name: string; command: string; executablePath: string }

/**
 * Rows as the wmic reader sees them, with PowerShell erroring so it cannot mask a
 * gap. Null means the reader refused the table outright — the duplicate-pid drop —
 * which is a safe outcome, not an answer.
 */
async function readViaWmic(rows: GeneratedProcess[]): Promise<ReadRow[] | null> {
  resetWindowsProcessRowsReaderForTests()
  const stdout = renderWmicValue(rows)
  execFileMock.mockImplementation((cmd: string, _a: unknown, _o: unknown, cb: unknown) => {
    const callback = cb as ExecFileCallback
    if (isWmic(cmd)) {
      callback(null, { stdout, stderr: '' })
      return
    }
    callback(new Error('powershell unavailable'), { stdout: '', stderr: '' })
  })
  try {
    return (await queryWindowsProcessRowsFresh()).map(toReadRow)
  } catch {
    return null
  }
}

const toReadRow = (r: ReadRow): ReadRow => ({
  pid: r.pid,
  ppid: r.ppid,
  name: r.name,
  command: r.command,
  executablePath: r.executablePath
})

/** The same table through the PowerShell/JSON reader — the reference answer. */
async function readViaPowerShell(rows: GeneratedProcess[]): Promise<ReadRow[]> {
  resetWindowsProcessRowsReaderForTests()
  const stdout = JSON.stringify(rows)
  execFileMock.mockImplementation((cmd: string, _a: unknown, _o: unknown, cb: unknown) => {
    const callback = cb as ExecFileCallback
    if (isWmic(cmd)) {
      callback(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), { stdout: '', stderr: '' })
      return
    }
    callback(null, { stdout, stderr: '' })
  })
  return (await queryWindowsProcessRowsFresh()).map(toReadRow)
}

const byPid = <T extends { pid: number }>(rows: T[]): T[] => [...rows].sort((a, b) => a.pid - b.pid)

describe('wmic reader vs PowerShell reader, over generated hostile tables', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    resetWindowsProcessRowsReaderForTests()
  })

  // Single-line command lines are the case the value format can represent without
  // loss, so nothing less than byte equality is acceptable there.
  it('agrees byte-for-byte with PowerShell on 400 newline-free tables', async () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const table = generateTable(seed, STRICT_FRAGMENTS, { multiline: false })
      const viaWmic = await readViaWmic(table)
      expect(viaWmic, `seed ${seed} was refused outright`).not.toBeNull()
      expect(byPid(viaWmic!), `seed ${seed}`).toEqual(byPid(await readViaPowerShell(table)))
    }
  })

  // With CR/LF in play the format is lossy in exactly two ways and no others: it
  // cannot tell a command's own newline from the record separator, and trailing
  // whitespace is indistinguishable from padding. Identity must still be exact —
  // only the command text is allowed to differ, and only by that normalization.
  it('agrees with PowerShell on 400 hostile multi-line tables, modulo CR/LF and padding', async () => {
    const normalize = (row: ReadRow): ReadRow => ({
      ...row,
      command: row.command.replace(/\r\n/g, '\n').trim()
    })
    for (let seed = 1; seed <= 400; seed += 1) {
      const table = generateTable(seed, NON_FORGING_FRAGMENTS)
      const viaWmic = await readViaWmic(table)
      expect(viaWmic, `seed ${seed} was refused outright`).not.toBeNull()
      expect(byPid(viaWmic!).map(normalize), `seed ${seed}`).toEqual(
        byPid(await readViaPowerShell(table)).map(normalize)
      )
    }
  })

  // The property `taskkill /T /F` targeting rests on. A forged row may invent a pid
  // that does not exist — inert, killing a dead pid no-ops — but must never restate
  // a live pid under a parent it does not have.
  it('never mis-parents a real pid on 400 tables that can forge the framing', async () => {
    let refused = 0
    for (let seed = 1; seed <= 400; seed += 1) {
      const table = generateTable(seed, FORGING_FRAGMENTS)
      const truth = new Map(table.map((row) => [row.ProcessId, row.ParentProcessId]))
      const viaWmic = await readViaWmic(table)
      if (viaWmic === null) {
        refused += 1
        continue
      }
      for (const row of viaWmic) {
        if (truth.has(row.pid)) {
          expect(truth.get(row.pid), `seed ${seed}, pid ${row.pid}`).toBe(row.ppid)
        }
      }
    }
    // Guard the guard: if forged tables stopped reaching the parser at all, the
    // property above would hold vacuously.
    expect(refused).toBeLessThan(400)
  })

  it('keeps every real pid present, so ancestry never silently loses a process', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const table = generateTable(seed, NON_FORGING_FRAGMENTS)
      const viaWmic = await readViaWmic(table)
      expect(viaWmic, `seed ${seed} was refused outright`).not.toBeNull()
      const seen = new Set(viaWmic!.map((row) => row.pid))
      for (const row of table) {
        expect(seen.has(row.ProcessId), `seed ${seed} lost pid ${row.ProcessId}`).toBe(true)
      }
    }
  })
})
