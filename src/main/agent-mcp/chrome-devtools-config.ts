import { lstatSync, readFileSync } from 'node:fs'

export const CHROME_DEVTOOLS_NAME = 'chrome-devtools'
export const CHROME_DEVTOOLS_ARGS = [
  '-y',
  'chrome-devtools-mcp@latest',
  '--autoConnect',
  '--no-usage-statistics',
  '--no-performance-crux'
]

export type ConfigPlan = {
  agent: 'codex' | 'opencode' | 'gemini' | 'pi'
  configPath: string
  before: string | null
  after: string
  prerequisite?: { hostVersion: string; adapterVersion: string; validation: string }
}

export function readConfig(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error(`Expected a regular config file (symlinks are unsupported): ${path}`)
    }
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function chromeDevtoolsCommand(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? ['cmd', '/c', 'npx', ...CHROME_DEVTOOLS_ARGS]
    : ['npx', ...CHROME_DEVTOOLS_ARGS]
}

export function matchesCommand(actual: unknown, expected: string[]): boolean {
  if (!Array.isArray(actual) || !actual.every((value) => typeof value === 'string')) {
    return false
  }
  // Older Orca registrations omit this optional privacy flag; preserve them unchanged.
  const withoutCruxFlag = (args: string[]) => args.filter((arg) => arg !== '--no-performance-crux')
  return JSON.stringify(withoutCruxFlag(actual)) === JSON.stringify(withoutCruxFlag(expected))
}

export function configConflict(path: string): Error {
  return new Error(
    `Conflicting chrome-devtools configuration in ${path}. Review the existing entry manually; no replacement was made.`
  )
}
