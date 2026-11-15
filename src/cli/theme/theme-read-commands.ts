import type { HandlerContext } from '../dispatch/dispatch'
import { pluginThemeTokenReference } from '../../shared/plugins/artifacts/plugin-theme-token-reference-doc'
import { TERMINAL_COLOR_KEYS } from '../../shared/terminal-themes/terminal-custom-themes'
import {
  THEME_STUDIO_TERMINAL_PREFIX,
  type ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import type { ThemeStudioReport } from '../../shared/theme-studio/theme-studio-protocol'
import { call, formatReport, print } from './theme-command-io'

type HistoryRow = {
  index: number
  label: string
  by?: string
  current: boolean
  saved?: string
  autoFixed?: number
}

type Status = {
  active: boolean
  name: string | null
  revision: number
  modes: ThemeStudioMode[]
  undo: number
  redo: number
  history: HistoryRow[]
  agentEditsAllowed?: boolean
  report?: ThemeStudioReport | null
  resolved?: { shownMode: ThemeStudioMode; modes: { mode: string; themeLabel: string | null }[] }
}

function historyLine(row: HistoryRow): string {
  const extra = [
    row.by ? `by ${row.by}` : null,
    row.autoFixed ? `${row.autoFixed} auto-fixed` : null,
    row.saved ? `saved as ${row.saved}` : null
  ].filter(Boolean)
  return `  ${row.current ? '>' : ' '} ${row.index} ${row.label}${extra.length ? ` (${extra.join(', ')})` : ''}`
}

export async function show(ctx: HandlerContext): Promise<void> {
  const result = await call<Status>(ctx, 'themeStudio.status', {
    resolved: ctx.flags.has('resolved')
  })
  const lines = result.active
    ? [
        `Previewing ${result.name} (${result.modes.join(' and ')}; revision ${result.revision}, undo ${result.undo}, redo ${result.redo})`,
        ...result.history.map(historyLine),
        ...formatReport(result.report ?? null)
      ]
    : ['No theme draft is open; `orca theme edit` starts one.']
  if (result.agentEditsAllowed === false) {
    lines.push('Agent theme edits are turned off in Settings → Appearance.')
  }
  if (result.resolved) {
    lines.push(
      `Shown: ${result.resolved.shownMode}`,
      ...result.resolved.modes.map(
        (mode) => `  ${mode.mode}: ${mode.themeLabel ?? 'Orca built-in'}`
      )
    )
  }
  print(ctx, result, lines.join('\n'))
}

export async function history(ctx: HandlerContext): Promise<void> {
  const result = await call<Status>(ctx, 'themeStudio.status', { report: false })
  print(
    ctx,
    { revision: result.revision, undo: result.undo, redo: result.redo, entries: result.history },
    result.history.length
      ? [
          `${result.name ?? 'Theme draft'} (revision ${result.revision})`,
          ...result.history.map(historyLine)
        ].join('\n')
      : 'No theme history; `orca theme edit` starts a draft.'
  )
}

export async function tokens(ctx: HandlerContext): Promise<void> {
  const reference = pluginThemeTokenReference()
  const terminal = TERMINAL_COLOR_KEYS.map((key) => `${THEME_STUDIO_TERMINAL_PREFIX}${key}`)
  print(
    ctx,
    { tokens: reference, terminal },
    [
      ...reference.map(
        ({ token, paints, required }) =>
          `${token.replace(/^--/, '')}${required ? ' (required)' : ''}: ${paints}`
      ),
      '',
      `Terminal: ${terminal.join(', ')}`
    ].join('\n')
  )
}
