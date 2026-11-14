import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/types'
import { validatePluginTarget } from '../plugins/authoring/plugin-folder-validation'
import type {
  ThemeStudioDraft,
  ThemeStudioMode
} from '../../shared/theme-studio/theme-studio-draft'
import { themeStudioPluginFiles } from '../../shared/theme-studio/theme-studio-plugin-files'
import { call, localPath, modesFlag, print, stringFlag } from './theme-command-io'

export async function shot(ctx: HandlerContext): Promise<void> {
  const modes = modesFlag(ctx)
  if (modes && modes.length > 1) {
    throw new RuntimeClientError('invalid_argument', '--mode for a shot is light or dark.')
  }
  const reply = await call<{
    png: string
    width: number
    height: number
    colorScheme: ThemeStudioMode
    themeApplied: boolean
    themeReason?: string
    draft: boolean
  }>(ctx, 'themeStudio.shot', modes ? { mode: modes[0] } : {})
  const out = stringFlag(ctx, 'out')
  const path = out
    ? localPath(ctx, out, 'shot')
    : join(tmpdir(), 'orca-theme-shots', `theme-${reply.colorScheme}-${Date.now()}.png`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(reply.png, 'base64'))
  const result = {
    path,
    width: reply.width,
    height: reply.height,
    mode: reply.colorScheme,
    themeApplied: reply.themeApplied,
    ...(reply.themeReason ? { themeReason: reply.themeReason } : {}),
    draft: reply.draft
  }
  print(
    ctx,
    result,
    [
      `Saved ${path} (${reply.width}x${reply.height}, ${reply.colorScheme}${reply.draft ? ', draft painted' : ''})`,
      ...(modes && !reply.themeApplied
        ? [`  note: --mode was not applied (${reply.themeReason ?? 'Orca could not paint it'}).`]
        : [])
    ].join('\n')
  )
}

export async function exportDraft(ctx: HandlerContext): Promise<void> {
  const target = stringFlag(ctx, 'dir')
  if (!target) {
    throw new RuntimeClientError('invalid_argument', 'Missing <dir>.')
  }
  const folder = localPath(ctx, target, 'export')
  if (existsSync(folder) && (!statSync(folder).isDirectory() || readdirSync(folder).length > 0)) {
    throw new RuntimeClientError('invalid_argument', `${folder} is not an empty folder.`, {
      nextSteps: ['Pass a new or empty folder.']
    })
  }
  const status = await call<{ draft: ThemeStudioDraft | null }>(ctx, 'themeStudio.status', {})
  if (!status.draft) {
    throw new RuntimeClientError('theme_no_draft', 'No theme draft is open.', {
      nextSteps: ['Start one with `orca theme edit`.']
    })
  }
  const name = stringFlag(ctx, 'name')
  const draft = name ? { ...status.draft, name } : status.draft
  const { id, files } = themeStudioPluginFiles(draft, stringFlag(ctx, 'id'))
  for (const [path, text] of Object.entries(files)) {
    const file = join(folder, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
  }
  const validation = await validatePluginTarget(folder)
  const result = { path: folder, id, files: Object.keys(files), validation }
  print(
    ctx,
    result,
    [
      `Wrote ${draft.name} to ${folder} (${Object.keys(files).length} files).`,
      validation.valid
        ? 'It passes `orca plugin validate`.'
        : 'It does not pass `orca plugin validate`:',
      ...validation.errors.map((error) => `  ${error}`)
    ].join('\n')
  )
  if (!validation.valid) {
    process.exitCode = 1
  }
}
