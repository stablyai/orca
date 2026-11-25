import { readFileSync } from 'node:fs'

export const JS_PLUGINS_CONFIG = 'config/oxlint-js-plugins.json'
// The root scan no longer loads these plugins, so their suppressions belong to the JS plugins scan.
const JS_PLUGIN_NAMES = JSON.parse(
  readFileSync(new URL(`../../../../${JS_PLUGINS_CONFIG}`, import.meta.url), 'utf8')
).jsPlugins.map((plugin) => plugin.name)
export const JS_PLUGIN_DISABLE_PATTERN = new RegExp(
  String.raw`\/[/*]\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\s[^\n]*\b(?:${JS_PLUGIN_NAMES.join('|')})\/`
)

function readConfigRules(configPath) {
  const url = new URL(`../../../../${configPath}`, import.meta.url)
  const config = JSON.parse(readFileSync(url, 'utf8'))
  return [config.rules, ...(config.overrides ?? []).map((override) => override.rules)].flatMap(
    (rules) => Object.keys(rules ?? {})
  )
}

// The root scan loads neither tsgolint nor the import plugin, so these rules' suppressions belong to their own scans.
const rootRuleNames = new Set(readConfigRules('.oxlintrc.json'))
const secondaryOnlyRuleNames = [
  ...new Set([
    ...readConfigRules('config/oxlint-code-quality-type-aware.json'),
    ...readConfigRules('config/oxlint-code-quality-native-plugins.json')
  ])
].filter((rule) => !rootRuleNames.has(rule))

export const SECONDARY_SCAN_DISABLE_PATTERN = new RegExp(
  String.raw`\/[/*]\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?\s[^\n]*(?:${secondaryOnlyRuleNames.map((rule) => rule.replaceAll('/', '\\/')).join('|')})(?![\w-])`
)
