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
const models = [
  {
    file: 'agent-list',
    provenance: 'orcaAgentList',
    contents: `
      export { buildAgentList, agentListRowsIn } from './mobile/src/agents/agent-list-model'
      export { selectAgentsNeedingYou, summarizeAgentListHosts, agentStatusGroup } from './mobile/src/agents/agent-list-rows'
      export { agentListPreview } from './mobile/src/agents/agent-list-row-text'
      export { formatAgentTypeLabel } from './src/shared/agent-status/presentation/agent-type-label'
    `
  },
  {
    file: 'connection-diagnostics',
    provenance: 'orcaConnectionDiagnostics',
    contents: `
      export { diagnoseConnection, getReportableConnectionIncidentId } from './mobile/src/diagnostics/connection-diagnostics-analysis'
      export { buildConnectionDiagnosticsReport, formatConnectionLogHistory } from './mobile/src/diagnostics/connection-diagnostics-report'
      export { boundConnectionDiagnosticsReport } from './mobile/src/diagnostics/connection-diagnostics-submission'
      export { redactConnectionLogText } from './mobile/src/diagnostics/connection-log-redaction'
      export { formatEndpoint } from './mobile/src/diagnostics/host-reachability'
      export { displayHostEndpoint } from './mobile/src/transport/hosts/host-endpoint'
      export { resolveHostEndpointEdit } from './mobile/src/transport/hosts/host-endpoint-edit'
      export { isTailscaleEndpoint } from './src/shared/remote-runtime/remote-runtime-tailscale-hint'
      export { installRuntime } from 'orca-diagnostic-runtime'
    `
  }
]
const manifestPath = join(project, 'tools/vendor/manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const runtime = 'orca-diagnostic-runtime'
const translation = 'orca-diagnostic-translation'

for (const model of models) {
  const source = `orca-${model.file}-entry.ts`
  const output = `entry/src/main/ets/vendor/${model.file}.js`
  const result = await build({
    absWorkingDir: upstream,
    stdin: { contents: model.contents, resolveDir: upstream, sourcefile: source },
    tsconfigRaw: {},
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    target: 'es2020',
    write: false,
    metafile: true,
    inject: model.file === 'connection-diagnostics' ? [runtime] : [],
    plugins: [
      {
        name: 'native-catalog-localization',
        setup(builder) {
          builder.onResolve({ filter: /\/i18n\/mobile-i18n$/ }, ({ path }) =>
            model.file === 'connection-diagnostics'
              ? { path: translation, namespace: 'orca' }
              : { path, external: true, sideEffects: false }
          )
          builder.onLoad({ filter: /^orca-diagnostic-translation$/, namespace: 'orca' }, () => ({
            contents: 'export function translate(_key, fallback) { return fallback }'
          }))
        }
      },
      {
        name: 'native-diagnostic-runtime',
        setup(builder) {
          builder.onResolve({ filter: /^orca-diagnostic-runtime$/ }, () => ({
            path: runtime,
            namespace: 'orca'
          }))
          builder.onLoad({ filter: /^orca-diagnostic-runtime$/, namespace: 'orca' }, () => ({
            contents: `
              let parseUrl
              let encodeText
              export function installRuntime(url, encode) { parseUrl = url; encodeText = encode }
              export class URL { constructor(value) { return parseUrl(value) } }
              export class TextEncoder { encode(value) { return encodeText(value) } }
            `
          }))
        }
      }
    ]
  })
  const emitted = Object.values(result.metafile.outputs)[0]
  if (emitted.imports.length > 0) {
    throw new Error(`The native ${model.file} model must run without external imports.`)
  }
  const inputFiles = Object.keys(emitted.inputs)
    .filter(
      (path) => path !== source && path !== `orca:${runtime}` && path !== `orca:${translation}`
    )
    .sort()
  if (!inputFiles.every((path) => /^(mobile\/src|src\/shared)\//.test(path))) {
    throw new Error(
      `The native ${model.file} model may bundle only first-party mobile and shared code.`
    )
  }
  execFileSync('git', ['diff', '--quiet', revision, '--', ...inputFiles], { cwd: upstream })
  const bytes = result.outputFiles[0].contents
  writeFileSync(join(project, output), bytes)
  manifest.sha256[output] = createHash('sha256').update(bytes).digest('hex')
  manifest[model.provenance] = { revision, esbuild: version, sources: inputFiles }
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
