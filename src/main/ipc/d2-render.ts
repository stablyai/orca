import { tmpdir } from 'node:os'
import { ipcMain } from 'electron'
import { runProcess } from '@orca/process-host'
import type { D2RenderRequest, D2RenderResult } from '../../shared/d2-render-types'
import { resolveCommandOnLocalPath } from './command-path-resolver'

const MAX_SOURCE_LENGTH = 256 * 1024
const MAX_SVG_BYTES = 8 * 1024 * 1024
const RENDER_TIMEOUT_MS = 15_000
const MAX_ERROR_LENGTH = 2_000
// Why: d2's --dark-theme follows the OS colour scheme, but Orca's theme is app-driven.
const LIGHT_THEME_ID = '0'
const DARK_THEME_ID = '200'

export type D2RenderDependencies = {
  runCommand?: typeof runProcess
  resolveCommand?: typeof resolveCommandOnLocalPath
}

export async function renderD2Diagram(
  { source, isDark }: D2RenderRequest,
  { runCommand = runProcess, resolveCommand = resolveCommandOnLocalPath }: D2RenderDependencies = {}
): Promise<D2RenderResult> {
  if (source.length > MAX_SOURCE_LENGTH) {
    return { ok: false, reason: 'error', message: 'Diagram source is too large' }
  }
  // Why: resolve per render so a d2 installed after launch, or a late shell PATH hydration, is seen.
  const program = await resolveCommand('d2')
  if (!program) {
    return { ok: false, reason: 'missing' }
  }
  let result
  try {
    result = await runCommand({
      program,
      // Why: --bundle=false stops d2 itself fetching icon URLs; the preview loads them like images.
      args: [
        '--theme',
        isDark ? DARK_THEME_ID : LIGHT_THEME_ID,
        '--pad',
        '16',
        // Why: d2's default fit-to-screen omits width/height, stretching small diagrams.
        '--scale',
        '1',
        '--bundle=false',
        '--no-xml-tag',
        '--omit-version',
        '-',
        '-'
      ],
      // Why: relative `...@imports` must not resolve against Orca's own working directory.
      cwd: tmpdir(),
      input: source,
      timeoutMs: RENDER_TIMEOUT_MS,
      maxOutputBytes: MAX_SVG_BYTES,
      killOnOutputLimit: true
    })
  } catch (error) {
    return { ok: false, reason: 'error', message: `d2 did not start: ${String(error)}` }
  }
  if (result.timedOut) {
    return { ok: false, reason: 'error', message: 'd2 timed out' }
  }
  if (result.outputTruncated) {
    return { ok: false, reason: 'error', message: 'Diagram output is too large' }
  }
  if (result.code !== 0) {
    return { ok: false, reason: 'error', message: formatD2Error(result.stderr) }
  }
  return { ok: true, svg: result.stdout }
}

// Why: d2 prints `err: failed to compile -: -:1:1: <msg>`; keep only `1:1: <msg>` lines.
function formatD2Error(stderr: string): string {
  const errors = stderr
    .split('\n')
    .filter((line) => line.startsWith('err: '))
    .map((line) => line.slice(5).replace(/^(failed to compile -: )?-:/, ''))
  return (errors.join('\n') || stderr.trim() || 'd2 failed').slice(0, MAX_ERROR_LENGTH)
}

export function registerD2RenderHandlers(): void {
  ipcMain.removeHandler('d2:render')
  ipcMain.handle('d2:render', (_event, args: D2RenderRequest): Promise<D2RenderResult> => {
    if (typeof args?.source !== 'string') {
      return Promise.resolve({ ok: false, reason: 'error', message: 'Invalid diagram source' })
    }
    return renderD2Diagram({ source: args.source, isDark: args.isDark === true })
  })
}
