import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  PluginEditorCheckIssue,
  PluginEditorStaticCheck
} from '../../main/plugins/testing/plugin-editor-static-check'
import { parsePluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import { pluginTestingFiles } from './plugin-test-runner'

export type PluginEditorCheck = {
  editor: string
  entry: string
  /** Plugin-relative files the entry loads, itself included. */
  files: string[]
  issues: PluginEditorCheckIssue[]
  /** `editor_eval`: likely refused by the frame, but found by a scan that can misread code. */
  warnings: PluginEditorCheckIssue[]
}

type EditorCheckModule = {
  checkPluginEditorEntry: (dir: string, entry: string) => Promise<PluginEditorStaticCheck>
}

/** Every custom editor's files, transpiled and resolved as the frame loads them; runs no code. */
export async function checkPluginEditors(
  dir: string,
  appRoot?: string
): Promise<PluginEditorCheck[]> {
  const parsed = parsePluginManifest(
    JSON.parse(await readFile(join(dir, 'orca-plugin.json'), 'utf8'))
  )
  const editors = parsed.ok ? parsed.manifest.contributes.customEditors : []
  if (editors.length === 0) {
    return []
  }
  // The check ships in the hooks bundle, which carries the frame's transpiler in plain Node.
  const loaded: Partial<EditorCheckModule> = await import(
    pathToFileURL(pluginTestingFiles(appRoot).hooks).href
  )
  const check = loaded.checkPluginEditorEntry
  if (!check) {
    throw new Error('this Orca build has no custom editor check')
  }
  const checks: PluginEditorCheck[] = []
  for (const editor of editors) {
    checks.push({ editor: editor.id, entry: editor.entry, ...(await check(dir, editor.entry)) })
  }
  return checks
}

/** Lines for one editor: how many files it loads, or each issue at its plugin location. */
export function formatPluginEditorCheck(check: PluginEditorCheck): string[] {
  const head = `${check.editor} (${check.entry}): `
  const line = (issue: PluginEditorCheckIssue) =>
    `${issue.location}: ${issue.message} [${issue.code}]`
  const warnings = check.warnings.map((warning) => `  warning: ${line(warning)}`)
  if (check.issues.length === 0) {
    return [`${head}ok, ${check.files.length} file(s) load`, ...warnings]
  }
  return [`${head}failed`, ...check.issues.map((issue) => `  ${line(issue)}`), ...warnings]
}
