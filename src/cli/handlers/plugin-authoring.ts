import type { CommandHandler } from '../dispatch'
import { createPluginFromTemplate, PluginCreateError } from '../plugin-authoring/plugin-create'
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
  formatPluginReleaseEntry,
  pluginReleaseEntryForFolder
} from '../plugin-authoring/plugin-release-entry'
import {
  printPluginResult,
  requirePluginPathArg,
  resolveLocalPluginPath
} from '../plugin-authoring/plugin-cli-output'
import { writePluginTypeFiles } from '../plugin-authoring/plugin-type-files'
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

function invalidError(report: PluginValidationReport): RuntimeClientError {
  return new RuntimeClientError(
    PLUGIN_INVALID_CODE,
    [
      `${report.file} is not a valid plugin file:`,
      ...report.errors.map((error) => `- ${error}`)
    ].join('\n'),
    {
      ...report,
      nextSteps: ['Fix the listed problems, then run `orca plugin validate` again.']
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
        ...(created.typeFiles.length > 0
          ? [`  ${created.typeFiles.join(', ')} (generated typings, ignored by Git)`]
          : []),
        ...formatGrants(report),
        'Next: orca plugin dev load <dir>'
      ].join('\n')
    )
  },
  'plugin types': async (ctx) => {
    const dir = resolveLocalPluginPath(ctx, requirePluginPathArg(ctx, 'dir'), 'types')
    let files: string[]
    try {
      files = await writePluginTypeFiles(dir)
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        `cannot write typings into ${dir}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    printPluginResult(
      ctx,
      { path: dir, files },
      [
        `Wrote Orca plugin typings into ${dir}:`,
        ...files.map((file) => `  ${file}`),
        'Extend them from tsconfig.json: { "extends": "./.orca/types/tsconfig.json" }'
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
  },
  'plugin release-entry': async (ctx) => {
    const path = resolveLocalPluginPath(ctx, requirePluginPathArg(ctx, 'path'), 'release-entry')
    const report = await readTarget(validatePluginTarget, path)
    if (report.kind !== 'plugin') {
      throw new RuntimeClientError(
        'invalid_argument',
        `${report.file} is a catalog; pass the plugin folder.`
      )
    }
    if (!report.valid) {
      throw invalidError(report)
    }
    const result = await pluginReleaseEntryForFolder(report)
    if (!result.entry) {
      // Why not plugin_invalid: the files are valid; HEAD or the repository is what is missing.
      throw new RuntimeClientError('invalid_argument', result.note ?? 'no catalog release entry', {
        ...result,
        nextSteps: ['Commit the plugin in a Git repository, then run this again.']
      })
    }
    printPluginResult(ctx, result, formatPluginReleaseEntry(result))
  }
}
