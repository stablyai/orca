import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { selectPluginTestNode, type PluginTestNode } from './plugin-test-node'

/** Plugin test files `orca plugin test` runs. */
export const PLUGIN_TEST_FILE = /\.test\.(?:tsx?|mts|jsx?|mjs)$/i
// Not plugin sources: dependencies, Orca's own generated files, VCS and build output.
const SKIPPED_DIRS = new Set(['node_modules', '.orca', '.git', 'dist', 'out', 'coverage'])

const defaultAppRoot = (): string => join(__dirname, '..', '..', '..')

/** The files Orca ships for testing components panels, from the app this CLI belongs to. */
export function pluginTestingFiles(appRoot = defaultAppRoot()) {
  const dir = join(appRoot, 'resources', 'plugins', 'declarative')
  return {
    runtime: join(dir, 'orca-runtime.mjs'),
    testing: join(dir, 'orca-testing.mjs'),
    hooks: join(dir, 'orca-test-hooks.mjs'),
    register: join(dir, 'orca-test-register.mjs')
  }
}

/** Test files under `dir`, plugin-relative with `/`, sorted. */
export async function findPluginTestFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(join(folder, entry.name))
        }
      } else if (entry.isFile() && PLUGIN_TEST_FILE.test(entry.name)) {
        found.push(relative(dir, join(folder, entry.name)).split(sep).join('/'))
      }
    }
  }
  await walk(dir)
  return found.sort()
}

export type PluginTestRunner = 'node' | 'vitest'

/** The plugin's own vitest when it has one installed, else Node's built-in runner. */
export function pluginTestRunner(dir: string): { runner: PluginTestRunner; entry?: string } {
  const vitest = join(dir, 'node_modules', 'vitest', 'vitest.mjs')
  return existsSync(vitest) ? { runner: 'vitest', entry: vitest } : { runner: 'node' }
}

/** A Vite config that resolves `orca` like the guest's import map and transpiles like Orca. */
export function pluginVitestConfig(files: ReturnType<typeof pluginTestingFiles>): string {
  const url = (path: string): string => JSON.stringify(pathToFileURL(path).href)
  const path = (value: string): string => JSON.stringify(value)
  return `// Written by \`orca plugin test\`. Do not edit.
import { transformPluginSourceForTest } from ${url(files.hooks)}

const SOURCE = /\\.(?:tsx?|mts|jsx)$/
export default {
  esbuild: false,
  plugins: [
    {
      name: 'orca-plugin-sources',
      enforce: 'pre',
      transform(code, id) {
        const file = id.split('?')[0]
        if (!SOURCE.test(file) || file.includes('/node_modules/')) return null
        return { code: transformPluginSourceForTest(file, code), map: null }
      }
    }
  ],
  resolve: {
    alias: [
      { find: /^orca$/, replacement: ${path(files.runtime)} },
      { find: /^orca\\/jsx-(?:dev-)?runtime$/, replacement: ${path(files.runtime)} },
      { find: /^orca\\/testing$/, replacement: ${path(files.testing)} }
    ]
  },
  test: {
    include: ['**/*.test.{ts,tsx,mts,js,jsx,mjs}'],
    exclude: ['**/node_modules/**', '**/.orca/**'],
    // One runtime instance for the panel and the kit: never let vite-node externalize them.
    server: { deps: { inline: [/resources[\\\\/]plugins[\\\\/]declarative/] } }
  }
}
`
}

/**
 * Runs the plugin's tests and resolves with the runner's exit code. Output streams through; with
 * `quietStdout` (the CLI's --json mode) the runner's stdout goes to stderr instead.
 */
export async function runPluginTests(options: {
  dir: string
  files: readonly string[]
  appRoot?: string
  quietStdout?: boolean
  node?: PluginTestNode
}): Promise<{ runner: PluginTestRunner; code: number; node: PluginTestNode['source'] }> {
  const testing = pluginTestingFiles(options.appRoot)
  const selected = pluginTestRunner(options.dir)
  const node = options.node ?? (await selectPluginTestNode())
  const env = { ...process.env, ...node.env, ORCA_PLUGIN_TEST_ROOT: options.dir }
  let args: string[]
  if (selected.runner === 'vitest' && selected.entry) {
    const configDir = join(options.dir, '.orca', 'test')
    await mkdir(configDir, { recursive: true })
    // `.orca/` is Orca's generated folder; it keeps itself out of Git.
    if (!existsSync(join(options.dir, '.orca', '.gitignore'))) {
      await writeFile(join(options.dir, '.orca', '.gitignore'), '*\n')
    }
    const config = join(configDir, 'vitest.config.mjs')
    await writeFile(config, pluginVitestConfig(testing))
    args = [selected.entry, 'run', '--config', config, '--root', options.dir, ...options.files]
  } else {
    args = [
      '--enable-source-maps',
      '--import',
      pathToFileURL(testing.register).href,
      '--test',
      ...options.files
    ]
  }
  const result = await runProcess({
    program: node.program,
    args,
    cwd: options.dir,
    env,
    timeoutMs: null,
    stdio: ['ignore', options.quietStdout ? 2 : 'inherit', 'inherit']
  })
  return { runner: selected.runner, code: result.code ?? 1, node: node.source }
}
