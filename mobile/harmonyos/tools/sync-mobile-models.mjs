import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const project = resolve(import.meta.dirname, '..')
const upstream = resolve(process.argv[2] ?? join(project, '../..'))
const { build, version } = createRequire(join(upstream, 'package.json'))('esbuild')
const revision = execFileSync(
  'git',
  ['rev-parse', '--verify', `${process.argv[3] ?? 'origin/main'}^{commit}`],
  {
    cwd: upstream,
    encoding: 'utf8'
  }
).trim()
const models = [
  {
    file: 'bundle-compat',
    provenance: 'orcaBundleCompat',
    contents: `
      export { evaluateCompat } from './mobile/src/transport/connection/protocol-compat'
      export { evaluateMobileWebBundleCompat, MOBILE_WEB_PAGE_VERSION_FLOOR, MOBILE_WEB_PAGE_VERSION_OPENS_TARGETS, SUPPORTED_MOBILE_WEB_BUNDLE_SCHEMA_VERSIONS } from './mobile/src/transport/web-bundle/mobile-web-bundle-compat'
    `
  },
  {
    file: 'terminal-rail',
    provenance: 'orcaTerminalRail',
    contents: `
      export { getSideRailStrip, hasTerminalDirectionPadSpace, sideRailStripAboveKeyboard } from './mobile/src/layout/side-rail-strip'
      export { createTerminalAccessoryRepeatController, TERMINAL_ACCESSORY_REPEAT_DELAY_MS } from './mobile/src/terminal/key-input/terminal-accessory-repeat'
    `
  },
  {
    file: 'terminal-shortcuts',
    provenance: 'orcaTerminalShortcuts',
    contents: `
      export { buildTerminalShortcutKey, normalizeShortcutKeyInput } from './mobile/src/terminal/key-input/terminal-accessory-keys'
      export { TERMINAL_SHORTCUT_SPECIAL_KEY_DEFINITIONS as TERMINAL_SHORTCUT_SPECIAL_KEYS } from './mobile/src/terminal/key-input/terminal-key-definitions'
      import { TERMINAL_ACCESSORY_KEY_DEFINITIONS as TERMINAL_ACCESSORY_KEYS } from './mobile/src/terminal/key-input/terminal-key-definitions'
      import { normalizeTerminalAccessoryLayoutPreference } from './mobile/src/terminal/key-input/terminal-accessory-layout'
      import { withTranslation } from 'orca-diagnostic-translation'
      export function terminalAccessoryLayout(value, directionPadAvailable) {
        return normalizeTerminalAccessoryLayoutPreference(value, undefined, directionPadAvailable)
      }
      export function describeBuiltInShortcut(id, translator) {
        const key = TERMINAL_ACCESSORY_KEYS.find((entry) => entry.id === id)
        return withTranslation(translator, () => key
          ? { label: key.label, title: key.accessibilityLabel ?? key.label }
          : { label: id, title: id })
      }
    `
  },
  {
    file: 'dictation-shortcut-mode',
    provenance: 'orcaDictationShortcutMode',
    contents: `
      export { dictationShortcutMode, dictationShortcutModeSettings } from './src/shared/dictation-shortcut-mode'
    `
  },
  {
    file: 'agent-list',
    provenance: 'orcaAgentList',
    contents: `
      export { buildAgentList, agentListRowsIn } from './mobile/src/agents/agent-list-model'
      export { selectActiveAgents, selectAgentsNeedingYou, summarizeAgentListHosts, agentStatusGroup } from './mobile/src/agents/agent-list-rows'
      export { agentListPreview } from './mobile/src/agents/agent-list-row-text'
      export { formatAgentTypeLabel } from './src/shared/agent-status/presentation/agent-type-label'
    `
  },
  {
    file: 'host-machine',
    provenance: 'orcaHostMachine',
    contents: `
      export { formatHostMachineLine } from './src/shared/host-machine-line'
      export { readMobileRuntimeHostPlatform } from './mobile/src/transport/connection/mobile-runtime-host-platform'
    `
  },
  {
    file: 'connection-diagnostics',
    provenance: 'orcaConnectionDiagnostics',
    contents: `
      export { diagnoseConnection, getReportableConnectionIncidentId } from './mobile/src/diagnostics/connection-diagnostics-analysis'
      export { buildConnectionDiagnosticsReport, formatConnectionLogHistory } from './mobile/src/diagnostics/connection-diagnostics-report'
      export { CONNECTION_DIAGNOSTICS_ENDPOINT, serializeConnectionDiagnosticsSubmission } from './mobile/src/diagnostics/connection-diagnostics-submission'
      export { redactConnectionLogText } from './mobile/src/diagnostics/connection-log-redaction'
      export { formatEndpoint } from './mobile/src/diagnostics/host-reachability'
      export { displayHostEndpoint } from './mobile/src/transport/hosts/host-endpoint'
      export { resolveHostEndpointEdit } from './mobile/src/transport/hosts/host-endpoint-edit'
      export { isTailscaleEndpoint } from './src/shared/remote-runtime/remote-runtime-tailscale-hint'
      export { relayHostCloseReasonFrom } from './src/shared/relay-host-close-reason'
      export { relayHostReachabilityForCloseCode } from './mobile/src/transport/relay/relay-host-reachability'
      export { installRuntime } from 'orca-diagnostic-runtime'
      import { classifyConnection, verdictDisplayLabel } from './mobile/src/transport/connection/connection-health'
      import { RelayHostReachabilityLatch } from './mobile/src/transport/relay/relay-host-reachability-latch'
      import { troubleshootCommonIssues } from './mobile/src/diagnostics/troubleshoot-common-issues'
      import { translate, withTranslation } from 'orca-diagnostic-translation'
      export const createRelayHostReachability = () => new RelayHostReachabilityLatch()
      export function getTroubleshootCommonIssues(endpoints, translator) {
        return withTranslation(translator, () => troubleshootCommonIssues(translate, endpoints))
      }
      export function describeDesktopConnection(args, translator) {
        return withTranslation(translator, () => {
          const verdict = classifyConnection(args)
          return { kind: verdict.kind, label: verdictDisplayLabel(verdict), detail: verdict.detail }
        })
      }
    `
  }
]
const manifestPath = join(project, 'tools/vendor/manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const runtime = 'orca-diagnostic-runtime'
const translation = 'orca-diagnostic-translation'
const selectedModel = process.argv[4]
if (selectedModel && !models.some((model) => model.file === selectedModel)) {
  throw new Error(`Unknown native model: ${selectedModel}`)
}

for (const model of models) {
  if (selectedModel && model.file !== selectedModel) {
    continue
  }
  const source = `orca-${model.file}-entry.ts`
  const output = `entry/src/main/ets/vendor/${model.file}.js`
  const localizes = model.file === 'connection-diagnostics' || model.file === 'terminal-shortcuts'
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
          builder.onResolve({ filter: /^orca-diagnostic-translation$/ }, () => ({
            path: translation,
            namespace: 'orca'
          }))
          builder.onResolve({ filter: /\/i18n\/mobile-i18n$/ }, ({ path }) =>
            localizes
              ? { path: translation, namespace: 'orca' }
              : { path, external: true, sideEffects: false }
          )
          if (model.file === 'terminal-shortcuts') {
            builder.onResolve(
              { filter: /^@react-native-async-storage\/async-storage$/ },
              ({ path }) => ({
                path,
                external: true,
                sideEffects: false
              })
            )
          }
          builder.onLoad({ filter: /^orca-diagnostic-translation$/, namespace: 'orca' }, () => ({
            contents: `
              let translator
              export function withTranslation(next, describe) {
                const previous = translator
                translator = next
                try { return describe() } finally { translator = previous }
              }
              export function translate(key, fallback, values) {
                const text = translator?.(key, fallback) ?? fallback
                return values ? text.replace(/{{(\\w+)}}/g, (token, name) => values[name] ?? token) : text
              }
            `
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
