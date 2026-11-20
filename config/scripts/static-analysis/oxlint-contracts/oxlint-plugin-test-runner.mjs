import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const oxlintPackageDirectory = path.dirname(
  createRequire(import.meta.url).resolve('oxlint/package.json')
)
const oxlintPath = path.join(oxlintPackageDirectory, 'bin', 'oxlint')

export function runOxlintPluginOnSource({ source, ...options }) {
  return runOxlintPluginOnSources({ ...options, sources: [source] })[0]
}

export function runOxlintPluginOnSources({
  pluginName,
  pluginPath,
  rules,
  sources,
  extension = 'tsx'
}) {
  const directory = mkdtempSync(path.join(tmpdir(), `orca-${pluginName}-lint-`))
  const sourcePaths = sources.map((_, index) =>
    path.join(directory, `sample-${index}.${extension}`)
  )
  const configPath = path.join(directory, 'oxlint.json')

  try {
    sources.forEach((source, index) => writeFileSync(sourcePaths[index], source))
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [],
        categories: {
          correctness: 'off',
          suspicious: 'off',
          pedantic: 'off',
          perf: 'off',
          style: 'off',
          restriction: 'off',
          nursery: 'off'
        },
        jsPlugins: [{ name: pluginName, specifier: pluginPath }],
        rules
      })
    )
    const result = spawnSync(
      process.execPath,
      [oxlintPath, '--config', configPath, '--format', 'json', ...sourcePaths],
      { encoding: 'utf8' }
    )
    if (result.error) {
      throw result.error
    }
    if (!result.stdout.trim()) {
      throw new Error(result.stderr || `${pluginName} did not produce Oxlint output`)
    }
    const diagnostics = JSON.parse(result.stdout).diagnostics
    const byFile = new Map(sourcePaths.map((file) => [file, []]))
    for (const diagnostic of diagnostics) {
      const findings = byFile.get(path.resolve(diagnostic.filename))
      if (!findings) {
        throw new Error(`Unexpected Oxlint diagnostic file: ${diagnostic.filename}`)
      }
      findings.push(diagnostic)
    }
    return sourcePaths.map((file) => byFile.get(file))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
