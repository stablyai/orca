import type { CommandHandler } from '../dispatch'
import {
  createPluginFromTemplate,
  PluginCreateError,
  writePluginFolder
} from '../plugin-authoring/plugin-create'
import { renderVscodeThemePlugin } from '../plugin-authoring/vscode-theme-conversion'
import { readVscodeThemes, VscodeThemeReadError } from '../plugin-authoring/vscode-theme-reading'
import {
  inspectPluginFolder,
  validatePluginTarget,
  type PluginInspection,
  type PluginValidationReport
} from '../plugin-authoring/plugin-folder-validation'
import {
  isPluginTemplateName,
  PLUGIN_TEMPLATE_NAMES
} from '../plugin-authoring/plugin-template-names'
import {
  printPluginResult,
  requirePluginPathArg,
  resolveLocalPluginPath
} from '../plugin-authoring/plugin-cli-output'
import { RuntimeClientError } from '../runtime/types'
import { PLUGIN_INVALID_CODE } from '../../shared/plugins/approval/plugin-cli-approval'

function optionalString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function formatGrants(report: PluginValidationReport): string[] {
  const plugin = report.plugin
  if (!plugin) {
    return []
  }
  return [
    `${plugin.pluginKey} ${plugin.version} (${plugin.grants.execution})`,
    `  ${plugin.grants.executionDescription}`,
    ...plugin.grants.capabilities.map((capability) => `  - ${capability.description}`),
    ...plugin.grants.contributions.map((item) => `  adds ${item.kind}: ${item.name}`),
    plugin.needsApproval
      ? '  Loading or enabling it needs --approve <fingerprint>; Orca prints the fingerprint.'
      : '  Content only: loads without approval.'
  ]
}

function invalidError(
  report: PluginValidationReport,
  extra: { warnings?: string[]; nextStep?: string } = {}
): RuntimeClientError {
  const warnings = extra.warnings ?? []
  return new RuntimeClientError(
    PLUGIN_INVALID_CODE,
    [
      `${report.file} is not a valid plugin file:`,
      ...report.errors.map((error) => `- ${error}`),
      ...warnings.map((warning) => `warning: ${warning}`)
    ].join('\n'),
    {
      ...report,
      ...(warnings.length ? { warnings } : {}),
      nextSteps: [
        extra.nextStep ?? 'Fix the listed problems, then run `orca plugin validate` again.'
      ]
    }
  )
}

async function readTarget<T extends PluginValidationReport>(
  read: (path: string) => Promise<T>,
  path: string
): Promise<T> {
  try {
    return await read(path)
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      error instanceof Error ? error.message : String(error)
    )
  }
}

function formatInspection(report: PluginInspection): string {
  return [
    ...formatGrants(report),
    ...(report.contentHash
      ? [
          `Content hash: ${report.contentHash} (${report.fileCount} files, ${report.totalBytes} bytes)`
        ]
      : [])
  ].join('\n')
}

export const PLUGIN_AUTHORING_HANDLERS: Record<string, CommandHandler> = {
  'plugin create': async (ctx) => {
    const dir = resolveLocalPluginPath(ctx, requirePluginPathArg(ctx, 'dir'), 'create')
    const template = optionalString(ctx.flags, 'template')
    if (!template || !isPluginTemplateName(template)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--template must be one of: ${PLUGIN_TEMPLATE_NAMES.join(', ')}`,
        { templates: [...PLUGIN_TEMPLATE_NAMES] }
      )
    }
    let created
    try {
      created = await createPluginFromTemplate({
        dir,
        template,
        publisher: optionalString(ctx.flags, 'publisher'),
        id: optionalString(ctx.flags, 'id'),
        name: optionalString(ctx.flags, 'name')
      })
    } catch (error) {
      if (error instanceof PluginCreateError) {
        throw new RuntimeClientError('invalid_argument', error.message)
      }
      throw error
    }
    const report = await validatePluginTarget(created.path)
    printPluginResult(
      ctx,
      { ...created, validation: report },
      [
        `Created ${created.pluginKey} from the ${template} template in ${created.path}`,
        ...created.files.map((file) => `  ${file}`),
        ...formatGrants(report),
        'Next: orca plugin dev load <dir>'
      ].join('\n')
    )
  },
  'plugin import-vscode-theme': async (ctx) => {
    const command = 'import-vscode-theme'
    const source = resolveLocalPluginPath(ctx, requirePluginPathArg(ctx, 'source'), command)
    const dir = resolveLocalPluginPath(ctx, requirePluginPathArg(ctx, 'dir'), command)
    let warnings: string[] = []
    let written
    try {
      const set = readVscodeThemes(source)
      written = await writePluginFolder(
        {
          dir,
          publisher: optionalString(ctx.flags, 'publisher'),
          id: optionalString(ctx.flags, 'id'),
          name: optionalString(ctx.flags, 'name') ?? set.name
        },
        (identity) => {
          const plugin = renderVscodeThemePlugin(set, identity)
          warnings = plugin.warnings
          return plugin
        }
      )
    } catch (error) {
      if (error instanceof PluginCreateError || error instanceof VscodeThemeReadError) {
        throw new RuntimeClientError('invalid_argument', error.message)
      }
      throw error
    }
    const report = await validatePluginTarget(written.path)
    if (!report.valid) {
      throw invalidError(report, {
        warnings,
        nextStep: `The converted files stay in ${written.path}: fix them and run \`orca plugin validate\`, or delete the folder and import again.`
      })
    }
    printPluginResult(
      ctx,
      { ...written, warnings, validation: report },
      [
        `Imported ${written.pluginKey} into ${written.path}`,
        ...written.files.map((file) => `  ${file}`),
        ...warnings.map((warning) => `warning: ${warning}`),
        ...formatGrants(report),
        'Next: orca plugin dev load <dir>'
      ].join('\n')
    )
  },
  'plugin validate': async (ctx) => {
    const path = resolveLocalPluginPath(ctx, requirePluginPathArg(ctx, 'path'), 'validate')
    const report = await readTarget(validatePluginTarget, path)
    if (!report.valid) {
      throw invalidError(report)
    }
    printPluginResult(ctx, report, [`${report.file}: ok`, ...formatGrants(report)].join('\n'))
  },
  'plugin inspect': async (ctx) => {
    const path = resolveLocalPluginPath(ctx, requirePluginPathArg(ctx, 'path'), 'inspect')
    const report = await readTarget(inspectPluginFolder, path)
    if (!report.valid) {
      throw invalidError(report)
    }
    printPluginResult(ctx, report, formatInspection(report))
  }
}
