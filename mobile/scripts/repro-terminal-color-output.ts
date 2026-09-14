import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ESC = String.fromCharCode(27)

export type TerminalColorSnapshot = {
  label: string
  handle: string
  cols: number | null
  rows: number | null
  serialized: string
  lines: string
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0
}

export function summarizeTerminalColorSnapshot(
  snapshot: TerminalColorSnapshot
): Record<string, string | number | null> {
  const data = snapshot.serialized
  return {
    label: snapshot.label,
    handle: snapshot.handle,
    cols: snapshot.cols,
    rows: snapshot.rows,
    serializedBytes: Buffer.byteLength(data),
    sgrTotal: countMatches(data, new RegExp(`${ESC}\\[[0-9;:]*m`, 'g')),
    sgrColor: countMatches(
      data,
      new RegExp(
        `${ESC}\\[(?:[0-9;:]*[;:])?(?:3[0-7]|4[0-7]|9[0-7]|10[0-7]|38[;:]|48[;:])[0-9;:]*m`,
        'g'
      )
    ),
    sgrReset: countMatches(data, new RegExp(`${ESC}\\[(?:0|39|49|0;39;49)m`, 'g')),
    altScreen: data.includes(`${ESC}[?1049h`) ? 'yes' : 'no',
    containsTruecolor: data.includes('38;2') || data.includes('38:2') ? 'yes' : 'no',
    containsPaletteColor: data.includes('38;5') || data.includes('38:5') ? 'yes' : 'no'
  }
}

export function saveTerminalColorSnapshots(snapshots: TerminalColorSnapshot[]): string {
  const dir = join(process.cwd(), 'terminal-color-repro')
  mkdirSync(dir, { recursive: true })
  for (const snapshot of snapshots) {
    const base = snapshot.label.replace(/[^a-z0-9_-]/gi, '-')
    writeFileSync(join(dir, `${base}.ansi`), snapshot.serialized || snapshot.lines)
    writeFileSync(
      join(dir, `${base}.escaped.txt`),
      JSON.stringify(snapshot.serialized || snapshot.lines)
    )
  }
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify(snapshots.map(summarizeTerminalColorSnapshot), null, 2)
  )
  return dir
}
