import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const project = resolve(import.meta.dirname, '..')
const upstream = resolve(process.argv[2] ?? join(project, '../..'))
const { build, version } = createRequire(join(upstream, 'package.json'))('esbuild')
const revision = execFileSync('git', ['rev-parse', 'origin/main'], {
  cwd: upstream,
  encoding: 'utf8'
}).trim()
const source = 'orca-agent-list-entry.ts'
const output = 'entry/src/main/ets/vendor/agent-list.js'
const result = await build({
  absWorkingDir: upstream,
  stdin: {
    contents: `
      export { buildAgentList, agentListRowsIn } from './mobile/src/agents/agent-list-model'
      export { selectAgentsNeedingYou, summarizeAgentListHosts, agentStatusGroup } from './mobile/src/agents/agent-list-rows'
      export { agentListPreview } from './mobile/src/agents/agent-list-row-text'
      export { formatAgentTypeLabel } from './src/shared/agent-status/presentation/agent-type-label'
    `,
    resolveDir: upstream,
    sourcefile: source
  },
  tsconfigRaw: {},
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2020',
  write: false,
  metafile: true,
  plugins: [
    {
      name: 'native-catalog-localization',
      setup(builder) {
        builder.onResolve({ filter: /\/i18n\/mobile-i18n$/ }, ({ path }) => ({
          path,
          external: true,
          sideEffects: false
        }))
      }
    }
  ]
})
const emitted = Object.values(result.metafile.outputs)[0]
if (emitted.imports.length > 0) {
  throw new Error('The native agent list model must run without external imports.')
}
const inputFiles = Object.keys(emitted.inputs)
  .filter((path) => path !== source)
  .sort()
if (!inputFiles.every((path) => /^(mobile\/src|src\/shared)\//.test(path))) {
  throw new Error('The native agent list may bundle only first-party mobile and shared code.')
}
execFileSync('git', ['diff', '--quiet', revision, '--', ...inputFiles], { cwd: upstream })
const bytes = result.outputFiles[0].contents
writeFileSync(join(project, output), bytes)
const manifestPath = join(project, 'tools/vendor/manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.sha256[output] = createHash('sha256').update(bytes).digest('hex')
manifest.orcaAgentList = { revision, esbuild: version, sources: inputFiles }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
