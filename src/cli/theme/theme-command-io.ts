import { isAbsolute, resolve } from 'node:path'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'
import { writeStdoutLine } from '../output/stdout-line'
import { REPEATED_FLAG_SEPARATOR } from '../arguments/args'
import {
  THEME_STUDIO_MODES,
  type ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import type { ThemeStudioReport } from '../../shared/theme-studio/theme-studio-protocol'

// Above the host's 10s for the window to answer, plus a report wait.
const RPC_TIMEOUT_MS = 30_000

// Why a cap: a whole-theme adjust touches ~100 colors; --json still lists every one.
const MAX_LISTED_KEYS = 12

export type Mutation = {
  name: string | null
  revision: number
  modes: ThemeStudioMode[]
  undo: number
  redo: number
  label: string
  changed?: Partial<Record<ThemeStudioMode, string[]>>
  skipped?: Partial<Record<ThemeStudioMode, string[]>>
  autoFixed?: number
  report: ThemeStudioReport | null
  paint?: { status: string; mode?: ThemeStudioMode; dropped: string[]; editor?: string }
}

export function print(ctx: HandlerContext, result: unknown, text: string): void {
  writeStdoutLine(ctx.json ? JSON.stringify({ ok: true, result }, null, 2) : text)
}

export async function call<T>(ctx: HandlerContext, method: string, params?: unknown): Promise<T> {
  try {
    return (await ctx.client.call<T>(method, params, { timeoutMs: RPC_TIMEOUT_MS })).result
  } catch (error) {
    if (
      error instanceof RuntimeRpcFailureError &&
      error.response.error.code === 'method_not_found'
    ) {
      throw new RuntimeClientError(
        'runtime_unsupported',
        'The Orca host this command reached is too old for `orca theme`.',
        { nextSteps: ['Update Orca on that host, then run the command again.'] }
      )
    }
    throw error
  }
}

export function stringFlag(ctx: HandlerContext, name: string): string | undefined {
  const value = ctx.flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function listFlag(ctx: HandlerContext, name: string): string[] {
  const value = stringFlag(ctx, name)
  return value
    ? value
        .split(REPEATED_FLAG_SEPARATOR)
        .map((part) => part.trim())
        .filter(Boolean)
    : []
}

export function numberFlag(ctx: HandlerContext, name: string): number | undefined {
  const value = stringFlag(ctx, name)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a number.`)
  }
  return parsed
}

/** --mode light|dark|both; `fallback` when absent (null: the mode Orca shows, decided by the host). */
export function modesFlag(ctx: HandlerContext): ThemeStudioMode[] | null {
  const value = stringFlag(ctx, 'mode')
  if (value === undefined) {
    return null
  }
  if (value === 'both') {
    return [...THEME_STUDIO_MODES]
  }
  if (value === 'light' || value === 'dark') {
    return [value]
  }
  throw new RuntimeClientError('invalid_argument', '--mode must be light, dark or both.')
}

/** Files here are on the machine running the CLI; a forwarding shell runs it on another one. */
export function localPath(ctx: HandlerContext, value: string, command: string): string {
  if (process.env.ORCA_CLI_CWD) {
    throw new RuntimeClientError(
      'invalid_environment',
      `orca theme ${command} reads and writes files on the machine that runs it, but this shell forwards orca to the Orca host. Run it on that machine.`
    )
  }
  return isAbsolute(value) ? value : resolve(ctx.cwd, value)
}

export function formatReport(report: ThemeStudioReport | null): string[] {
  if (!report) {
    return ['Contrast: not checked (the window did not paint in time).']
  }
  return report.modes.flatMap(({ mode, shown, findings }) => [
    `${mode}${shown ? ' (shown)' : ''}: ${findings.length === 0 ? 'passes the contrast check' : `${findings.length} finding(s)`}`,
    ...findings.flatMap((finding) => {
      const ratio =
        finding.ratio === undefined
          ? ''
          : finding.ratio === null
            ? ', translucent'
            : `, ${finding.ratio}:1 (min ${finding.min})`
      const best = finding.fixes[0]
      return [
        `  ${finding.id}${ratio}: ${finding.effect}`,
        ...(best
          ? [
              `    fix: ${Object.entries(best.set)
                .map(([token, value]) => `${token.replace(/^--/, '')}=${value}`)
                .join(' ')}${finding.command ? `  (${finding.command})` : ''}`
            ]
          : [])
      ]
    })
  ])
}

function formatMutation(result: Mutation): string {
  const changed = Object.entries(result.changed ?? {})
    .filter(([, keys]) => keys.length > 0)
    .map(
      ([mode, keys]) =>
        `  ${mode}: ${keys.length > MAX_LISTED_KEYS ? `${keys.length} colors` : keys.join(', ')}`
    )
  const skipped = Object.entries(result.skipped ?? {}).map(
    ([mode, keys]) => `  skipped in ${mode} (not a color it can read): ${keys.join(', ')}`
  )
  return [
    `${result.label} - ${result.name ?? 'no draft'} (revision ${result.revision}, undo ${result.undo}, redo ${result.redo})`,
    ...(changed.length ? ['Changed:', ...changed] : []),
    ...skipped,
    ...(result.autoFixed ? [`Fixed ${result.autoFixed} contrast issue(s) in the same step.`] : []),
    ...(result.paint
      ? [
          `Paint: ${result.paint.status}${result.paint.mode ? ` (${result.paint.mode})` : ''}${result.paint.dropped.length ? `; left unpainted: ${result.paint.dropped.join(', ')}` : ''}${result.paint.editor === 'pinned' ? '; the editor keeps its own theme' : ''}`
        ]
      : []),
    ...formatReport(result.report)
  ].join('\n')
}

/** Who is asking and the revision they read, sent with every change. */
export function callerParams(ctx: HandlerContext): { terminal?: string; ifRevision?: number } {
  const terminal = process.env.ORCA_TERMINAL_HANDLE?.trim()
  const ifRevision = numberFlag(ctx, 'if-revision')
  return {
    ...(terminal ? { terminal } : {}),
    ...(ifRevision === undefined ? {} : { ifRevision })
  }
}

export async function mutate(
  ctx: HandlerContext,
  method: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  const result = await call<Mutation>(ctx, method, { ...params, ...callerParams(ctx) })
  print(ctx, result, formatMutation(result))
}
