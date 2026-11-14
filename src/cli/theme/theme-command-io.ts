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
  report: ThemeStudioReport | null
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
  return report.modes.flatMap(({ mode, shown, issues }) => [
    `${mode}${shown ? ' (shown)' : ''}: ${issues.length === 0 ? 'passes the contrast check' : `${issues.length} contrast issue(s)`}`,
    ...issues.map((issue) => {
      const pair =
        issue.text && issue.surface ? `${issue.text} on ${issue.surface}` : issue.tokens.join(', ')
      const ratio =
        issue.ratio === undefined ? '' : issue.ratio === null ? ' translucent' : ` ${issue.ratio}:1`
      const min = issue.min === undefined ? '' : ` (min ${issue.min})`
      const fix = issue.fix
        ? ` -> fix ${issue.fix.token.replace(/^--/, '')}=${issue.fix.value}`
        : ''
      return `  ${issue.problem}: ${pair}${ratio}${min}; unpainted ${issue.tokens.join(', ')}${fix}`
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
    ...formatReport(result.report)
  ].join('\n')
}

export async function mutate(ctx: HandlerContext, method: string, params?: unknown): Promise<void> {
  const result = await call<Mutation>(ctx, method, params)
  print(ctx, result, formatMutation(result))
}
