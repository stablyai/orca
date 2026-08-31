import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ESC = String.fromCharCode(27)

export type StartupTerminalCapture = {
  handle: string
  title: string | null
  scrollback: Record<string, unknown> | null
  chunks: string[]
}

function stripAnsi(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- intentional terminal escape stripping for repro summaries
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      // eslint-disable-next-line no-control-regex -- intentional terminal escape stripping for repro summaries
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '\n')
  )
}

function normalizePreview(value: string): string {
  return stripAnsi(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n')
}

export function summarizeStartupCapture(capture: StartupTerminalCapture): Record<string, unknown> {
  const serialized =
    typeof capture.scrollback?.serialized === 'string' ? capture.scrollback.serialized : ''
  const live = capture.chunks.join('')
  const serializedPreview = normalizePreview(serialized)
  const livePreview = normalizePreview(live)
  return {
    handle: capture.handle,
    title: capture.title,
    cols: capture.scrollback?.cols ?? null,
    rows: capture.scrollback?.rows ?? null,
    serializedBytes: Buffer.byteLength(serialized),
    liveBytes: Buffer.byteLength(live),
    liveChunks: capture.chunks.length,
    serializedSgr: (serialized.match(new RegExp(`${ESC}\\[[0-9;:]*m`, 'g')) ?? []).length,
    liveSgr: (live.match(new RegExp(`${ESC}\\[[0-9;:]*m`, 'g')) ?? []).length,
    livePreviewContainedInSerialized:
      livePreview.length > 0 && stripAnsi(serialized).includes(livePreview.split('\n')[0] ?? ''),
    serializedPreview,
    livePreview
  }
}

export function saveStartupCaptures(
  captures: StartupTerminalCapture[],
  worktreeName: string
): string {
  const dir = join(process.cwd(), 'terminal-startup-repro', worktreeName)
  mkdirSync(dir, { recursive: true })
  for (const capture of captures) {
    const base = capture.handle.replace(/[^a-z0-9_-]/gi, '-')
    const serialized =
      typeof capture.scrollback?.serialized === 'string' ? capture.scrollback.serialized : ''
    writeFileSync(join(dir, `${base}.serialized.ansi`), serialized)
    writeFileSync(join(dir, `${base}.live.ansi`), capture.chunks.join(''))
    writeFileSync(join(dir, `${base}.json`), JSON.stringify(capture, null, 2))
  }
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify(captures.map(summarizeStartupCapture), null, 2)
  )
  return dir
}
