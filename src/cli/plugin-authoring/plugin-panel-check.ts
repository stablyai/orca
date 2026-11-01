import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import { parsePluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
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
  /** Elements drawn on the first render; 0 when it never rendered. */
  elements: number
  issues: PluginPanelCheckIssue[]
  warnings: string[]
}

const checkReportSchema = z.array(
  z.object({
    panel: z.string(),
    entry: z.string(),
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

// Runs inside the plugin's Node process with the test hooks: mount each panel once, report back.
const CHECK_SCRIPT = `
const { mount, mockHost } = await import('orca/testing')
const panels = JSON.parse(process.env.ORCA_PLUGIN_CHECK_PANELS)
const results = []
let stray = []
process.on('unhandledRejection', (error) => stray.push(error))
for (const { panel, entry, url } of panels) {
  const result = { panel, entry, elements: 0, issues: [], warnings: [] }
  stray = []
  try {
    const mounted = await mount(await import(url), { host: mockHost(), panelId: panel })
    result.elements = mounted.findAll({}).length
    result.issues.push(...mounted.errors)
    result.warnings.push(...mounted.warnings)
    await mounted.unmount()
  } catch (error) {
    stray.push(error)
  }
  for (const error of stray) {
    result.issues.push({ kind: 'plugin', message: String(error?.message ?? error), stack: error?.stack })
  }
  results.push(result)
}
process.stdout.write('\\n__ORCA_CHECK__' + JSON.stringify(results))
`

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

/** Renders every components panel once against a stand-in host, in a Node process. */
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
  const panels = parsed.manifest.contributes.panels
    .filter((panel) => panel.ui === 'components')
    .map((panel) => ({
      panel: panel.id,
      entry: panel.entry,
      url: pathToFileURL(join(dir, ...panel.entry.split('/'))).href
    }))
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
      CHECK_SCRIPT
    ],
    cwd: dir,
    env: {
      ...process.env,
      ...node.env,
      ORCA_PLUGIN_TEST_ROOT: dir,
      ORCA_PLUGIN_CHECK_PANELS: JSON.stringify(panels)
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
    issues: check.issues.map(({ stack, ...issue }) => {
      const location = pluginStackLocation(realDir, stack)
      return location ? { ...issue, location } : issue
    })
  }))
}
