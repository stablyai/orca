import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const SOURCE_DIRS = ['src/main', 'src/relay', 'src/shared', 'src/preload', 'src/renderer/src']
const BUILT_DIRS = ['out/main', 'out/relay']
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

const SOURCE_RULES = [
  {
    id: 'bare-pwsh-process-launch',
    message: 'Resolve pwsh.exe through shared/windows-powershell-executable before spawning it.',
    pattern:
      /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(['"`])pwsh(?:\.exe)?\1|\bexec\s*\(\s*(['"`])pwsh(?:\.exe)?\b[^)]*\2/gi
  },
  {
    id: 'relay-main-powershell-resolver-import',
    message: 'Relay code must import the shared PowerShell resolver, not main/providers.',
    pattern: /from\s+['"](?:\.\.\/)+main\/providers\/windows-powershell-executable['"]/g
  },
  {
    id: 'interactive-powershell-startup-encodedcommand',
    message: 'Interactive PowerShell PTY startup commands must be delivered after shell-ready.',
    pattern: /\$\{bootstrap\}\\n\$\{startupCommand\}/g
  }
]

const BUILT_RULES = [
  {
    id: 'packaged-bare-pwsh-probe',
    message: 'Packaged output must not contain a bare pwsh.exe process probe.',
    pattern:
      /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(['"`])pwsh(?:\.exe)?\1|\bexec\s*\(\s*(['"`])pwsh(?:\.exe)?\b[^)]*\2/gi
  },
  {
    id: 'packaged-powershell-startup-payload',
    message: 'Packaged output must not append startup commands to PowerShell EncodedCommand.',
    pattern: /\$\{bootstrap\}\\n\$\{startupCommand\}/g
  }
]

function isScannedFile(filePath) {
  if (!SCANNED_EXTENSIONS.has(path.extname(filePath))) {
    return false
  }
  const normalized = filePath.replaceAll('\\', '/')
  return (
    !normalized.includes('/node_modules/') &&
    !normalized.includes('/.git/') &&
    !normalized.includes('.test.') &&
    !normalized.includes('.spec.')
  )
}

function walkFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return []
  }
  const files = []
  const stack = [rootDir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          stack.push(entryPath)
        }
        continue
      }
      if (entry.isFile() && isScannedFile(entryPath)) {
        files.push(entryPath)
      }
    }
  }
  return files
}

function collectRuleReports(filePath, text, rules) {
  const reports = []
  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    let match = rule.pattern.exec(text)
    while (match) {
      const line = text.slice(0, match.index).split(/\r?\n/).length
      reports.push({ filePath, line, ruleId: rule.id, message: rule.message })
      match = rule.pattern.exec(text)
    }
  }
  return reports
}

export function checkWindowsPowerShellSourceGuardrails(repoRoot) {
  const reports = []
  for (const sourceDir of SOURCE_DIRS) {
    for (const filePath of walkFiles(path.join(repoRoot, sourceDir))) {
      const text = readFileSync(filePath, 'utf8')
      reports.push(...collectRuleReports(filePath, text, SOURCE_RULES))
    }
  }
  return reports
}

export function checkWindowsPowerShellBuiltGuardrails(repoRoot) {
  const reports = []
  for (const builtDir of BUILT_DIRS) {
    const absoluteDir = path.join(repoRoot, builtDir)
    if (!existsSync(absoluteDir)) {
      continue
    }
    for (const filePath of walkFiles(absoluteDir)) {
      const text = readFileSync(filePath, 'utf8')
      reports.push(...collectRuleReports(filePath, text, BUILT_RULES))
    }
  }
  return reports
}

export function checkWindowsPowerShellGuardrails(repoRoot) {
  return [
    ...checkWindowsPowerShellSourceGuardrails(repoRoot),
    ...checkWindowsPowerShellBuiltGuardrails(repoRoot)
  ]
}

function formatReport(repoRoot, report) {
  const relativePath = path.relative(repoRoot, report.filePath)
  return `${relativePath}:${report.line} ${report.ruleId} - ${report.message}`
}

function main() {
  const repoRoot = process.cwd()
  const includeBuilt = process.argv.includes('--include-built')
  const reports = includeBuilt
    ? checkWindowsPowerShellGuardrails(repoRoot)
    : checkWindowsPowerShellSourceGuardrails(repoRoot)
  if (reports.length === 0) {
    return
  }
  console.error('Windows PowerShell guardrail violations:')
  for (const report of reports) {
    console.error(`  ${formatReport(repoRoot, report)}`)
  }
  process.exitCode = 1
}

if (process.argv[1] === import.meta.filename) {
  main()
}
