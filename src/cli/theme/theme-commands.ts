import { existsSync } from 'node:fs'
import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/types'
import {
  THEME_STUDIO_MODES,
  type ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import {
  call,
  callerParams,
  listFlag,
  numberFlag,
  localPath,
  modesFlag,
  mutate,
  print,
  stringFlag
} from './theme-command-io'
import {
  adjustmentFlags,
  assignmentsPatch,
  isRecord,
  mergePatches,
  onlyPrefixes,
  patchFlag
} from './theme-command-args'
import { draftFromLocal } from './theme-local-draft'
import { exportDraft, shot } from './theme-file-commands'
import { history, show, tokens } from './theme-read-commands'

async function edit(ctx: HandlerContext): Promise<void> {
  const from = stringFlag(ctx, 'from') ?? 'current'
  const name = stringFlag(ctx, 'name')
  // Why the shape check: in a forwarding shell only a path needs local files; a theme id does not.
  const pathLike = /[\\/]/.test(from) || from.startsWith('.') || /\.json$/i.test(from)
  const local =
    from === 'current' || (process.env.ORCA_CLI_CWD && !pathLike)
      ? null
      : localPath(ctx, from, 'edit')
  const source =
    from === 'current'
      ? { kind: 'current' }
      : local && existsSync(local)
        ? { kind: 'draft', draft: await draftFromLocal(local) }
        : { kind: 'installed', target: from }
  await mutate(ctx, 'themeStudio.edit', { from: source, ...(name ? { name } : {}) })
}

async function set(ctx: HandlerContext): Promise<void> {
  const assigns = listFlag(ctx, 'assignment').length > 0 || listFlag(ctx, 'unset').length > 0
  const modes = modesFlag(ctx) ?? (assigns ? [await shownMode(ctx)] : [])
  const patch = mergePatches(await patchFlag(ctx), assignmentsPatch(ctx, modes))
  if (!isRecord(patch) || Object.keys(patch).length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Nothing to set.', {
      nextSteps: ['Pass <token>=<color> pairs, --unset <token> or --patch <json>.']
    })
  }
  await mutate(ctx, 'themeStudio.patch', {
    patch,
    label: `Set ${listFlag(ctx, 'assignment').join(' ') || 'tokens'}`.slice(0, 256)
  })
}

async function shownMode(ctx: HandlerContext): Promise<ThemeStudioMode> {
  const status = await call<{ resolved?: { shownMode: ThemeStudioMode } }>(
    ctx,
    'themeStudio.status',
    { resolved: true, report: false }
  )
  return status.resolved?.shownMode ?? 'dark'
}

async function adjust(ctx: HandlerContext): Promise<void> {
  const adjustment = adjustmentFlags(ctx)
  const separate = numberFlag(ctx, 'separate')
  if (Object.keys(adjustment).length === 0 && separate === undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass at least one of --warmth, --hue, --saturation, --lightness, --contrast or --separate.'
    )
  }
  const only = onlyPrefixes(ctx)
  await mutate(ctx, 'themeStudio.adjust', {
    modes: modesFlag(ctx) ?? [...THEME_STUDIO_MODES],
    adjustment,
    ...(only ? { only } : {}),
    ...(separate === undefined
      ? {}
      : { separate: { scope: stringFlag(ctx, 'scope') ?? 'sidebar', amount: separate } })
  })
}

async function apply(ctx: HandlerContext): Promise<void> {
  const name = stringFlag(ctx, 'name')
  const result = await call<{
    pluginKey: string
    version: string
    name: string
    folder: string
    selected: boolean
    modes: ThemeStudioMode[]
  }>(ctx, 'themeStudio.apply', { ...(name ? { name } : {}), ...callerParams(ctx) })
  print(
    ctx,
    result,
    `Saved ${result.name} as ${result.pluginKey} (${result.modes.join(' and ')})${result.selected ? ' and switched to it' : ''}.`
  )
}

export const THEME_HANDLERS: Record<string, CommandHandler> = {
  'theme show': show,
  'theme tokens': tokens,
  'theme history': history,
  'theme reset': (ctx) => mutate(ctx, 'themeStudio.reset'),
  'theme edit': edit,
  'theme set': set,
  'theme adjust': adjust,
  'theme check': (ctx) => {
    const findings = listFlag(ctx, 'finding')
    return mutate(ctx, 'themeStudio.check', {
      fix: ctx.flags.has('fix') || findings.length > 0,
      ...(findings.length ? { findings } : {})
    })
  },
  'theme undo': (ctx) => mutate(ctx, 'themeStudio.step', { direction: 'undo' }),
  'theme redo': (ctx) => mutate(ctx, 'themeStudio.step', { direction: 'redo' }),
  'theme shot': shot,
  'theme apply': apply,
  'theme discard': async (ctx) => {
    const result = await call<{ discarded: boolean; name: string | null }>(
      ctx,
      'themeStudio.discard',
      callerParams(ctx)
    )
    print(ctx, result, result.discarded ? `Discarded ${result.name}.` : 'No theme draft was open.')
  },
  'theme export': exportDraft
}
