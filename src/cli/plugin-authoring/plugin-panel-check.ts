import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { parsePluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_PANEL_CHECK_SCRIPT } from './plugin-panel-check-script'
import { selectPluginTestNode } from './plugin-test-node'
import { pluginTestingFiles } from './plugin-test-runner'

export type PluginPanelCheckIssue = {
  kind: 'plugin' | 'refused'
  message: string
  /** `file:line:column` inside the plugin, when the error's stack names one. */
  location?: string
}
export type PluginPanelCheck = {
  panel: string
  entry: string
  /** The `<entry>.check.ts` scenario this render used, when the panel has one. */
  scenario?: string
  /** Elements drawn on the first render; 0 when it never rendered. */
  elements: number
  issues: PluginPanelCheckIssue[]
  warnings: string[]
}

const checkReportSchema = z.array(
  z.object({
    panel: z.string(),
    entry: z.string(),
    scenario: z.string().optional(),
    elements: z.number(),
    issues: z.array(
      z.object({
        kind: z.enum(['plugin', 'refused']),
        message: z.string(),
        stack: z.string().optional()
      })
    ),
    warnings: z.array(z.string())
  })
)

/** The first stack frame inside the plugin folder, as `path:line:column`. */
export function pluginStackLocation(dir: string, stack: string | undefined): string | undefined {
  for (const match of stack?.matchAll(
    /(file:\/\/[^\s)]+|\/[^\s():]+|[A-Za-z]:\\[^\s():]+):(\d+):(\d+)/g
  ) ?? []) {
    const file = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1]
    const path = relative(dir, file)
    if (path && !path.startsWith('..') && !path.split(sep).includes('node_modules')) {
      return `${path.split(sep).join('/')}:${match[2]}:${match[3]}`
    }
  }
  return undefined
}

// `src/panel.tsx:4:7: Unexpected token`, as Orca's loaders word transpile and import errors.
const LOCATED_MESSAGE = /^([^\n:]+\.[a-z]+:\d+:\d+): ([\s\S]*)$/i

/** One issue per distinct problem, located from its message or else its first plugin frame. */
export function pluginPanelCheckIssues(
  dir: string,
  reported: readonly { kind: PluginPanelCheckIssue['kind']; message: string; stack?: string }[]
): PluginPanelCheckIssue[] {
  const issues = new Map<string, PluginPanelCheckIssue>()
  for (const { stack, ...issue } of reported) {
    const located = LOCATED_MESSAGE.exec(issue.message)
    const location = located?.[1] ?? pluginStackLocation(dir, stack)
    const message = located?.[2] ?? issue.message
    const key = JSON.stringify([issue.kind, location, message])
    if (!issues.has(key)) {
      issues.set(key, location ? { ...issue, message, location } : { ...issue, message })
    }
  }
  return [...issues.values()]
}

const FIXTURE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs']

/** `src/panel.check.ts` beside `src/panel.tsx`: the scenarios check renders the panel in. */
export function pluginCheckFixturePath(dir: string, entry: string): string | null {
  const stem = entry.replace(/\.[^./]+$/, '')
  return (
    FIXTURE_EXTENSIONS.map((extension) => `${stem}.check${extension}`).find((path) =>
      existsSync(join(dir, ...path.split('/')))
    ) ?? null
  )
}

/** Renders every components panel once per scenario against a stand-in host, in a Node process;
 *  a plugin with a worker (`main`) runs it on the same host, so panel requests reach it. */
export async function checkPluginPanels(
  dir: string,
  appRoot?: string
): Promise<PluginPanelCheck[]> {
  const parsed = parsePluginManifest(
    JSON.parse(await readFile(join(dir, 'orca-plugin.json'), 'utf8'))
  )
  if (!parsed.ok) {
    return []
  }
  const fileUrl = (path: string): string => pathToFileURL(join(dir, ...path.split('/'))).href
  const panels = parsed.manifest.contributes.panels
    .filter((panel) => panel.ui === 'components')
    .map((panel) => {
      const fixture = pluginCheckFixturePath(dir, panel.entry)
      return {
        panel: panel.id,
        entry: panel.entry,
        url: fileUrl(panel.entry),
        ...(fixture ? { fixture: { path: fixture, url: fileUrl(fixture) } } : {})
      }
    })
  const main = parsed.manifest.main
    ? { path: parsed.manifest.main, url: fileUrl(parsed.manifest.main) }
    : null
  if (panels.length === 0) {
    return []
  }
  const testing = pluginTestingFiles(appRoot)
  const node = await selectPluginTestNode()
  const result = await runProcess({
    program: node.program,
    args: [
      '--enable-source-maps',
      '--import',
      pathToFileURL(testing.register).href,
      '--input-type=module',
      '--eval',
      PLUGIN_PANEL_CHECK_SCRIPT
    ],
    cwd: dir,
    env: {
      ...process.env,
      ...node.env,
      ORCA_PLUGIN_TEST_ROOT: dir,
      ORCA_PLUGIN_CHECK_PANELS: JSON.stringify({ panels, main })
    },
    timeoutMs: 60_000
  })
  const marker = result.stdout.lastIndexOf('__ORCA_CHECK__')
  if (marker === -1) {
    // The process died before reporting (a syntax error in a module, say): report what it said.
    const message = (result.stderr || result.stdout).trim().split('\n').slice(0, 20).join('\n')
    return panels.map(({ panel, entry }) => ({
      panel,
      entry,
      elements: 0,
      issues: [{ kind: 'plugin', message: message || `exited with code ${result.code}` }],
      warnings: []
    }))
  }
  const reported = checkReportSchema.parse(
    JSON.parse(result.stdout.slice(marker + '__ORCA_CHECK__'.length))
  )
  // Stacks name real paths (macOS /var is /private/var).
  const realDir = realpathSync(dir)
  return reported.map((check) => ({
    ...check,
    issues: pluginPanelCheckIssues(realDir, check.issues),
    warnings: [...new Set(check.warnings)]
  }))
}

/** Lines for one panel: what it drew, or each issue at its plugin location. */
export function formatPluginPanelCheck(check: PluginPanelCheck): string[] {
  const head = `${check.panel} (${check.entry}${check.scenario ? `, scenario "${check.scenario}"` : ''}): `
  if (check.issues.length === 0) {
    return [
      `${head}rendered ${check.elements} element(s)`,
      ...check.warnings.map((warning) => `  warning: ${warning}`)
    ]
  }
  return [
    `${head}failed`,
    ...check.issues.map(
      (issue) =>
        `  ${issue.location ?? check.entry}: ${issue.kind === 'refused' ? 'Orca would refuse this render: ' : ''}${issue.message}`
    ),
    ...check.warnings.map((warning) => `  warning: ${warning}`)
  ]
}
