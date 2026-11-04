import { runProcessSync } from '@orca/process-host'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  AUDIT_WORKSPACES,
  evaluateSecurityAudit,
  securityExceptions
} from './dependency-security-audit.mjs'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

const ROOT = resolve(import.meta.dirname, '../..')

export function readSecurityAudit(result) {
  if (
    result.signal ||
    result.timedOut ||
    result.outputTruncated ||
    (result.code !== 0 && result.code !== 1)
  ) {
    throw new Error(`Dependency audit failed (${result.code}): ${result.stderr || result.stdout}`)
  }
  const report = JSON.parse(result.stdout)
  if (result.code === 1 && Object.keys(report.advisories ?? {}).length === 0) {
    throw new Error('Audit failed without a vulnerability report')
  }
  return report
}

export function checkDependencySecurity(root = ROOT, workspaces = AUDIT_WORKSPACES) {
  const exceptions = securityExceptions.parse(
    JSON.parse(readFileSync(join(ROOT, 'config/dependency-security-exceptions.json'), 'utf8'))
  )
  const reportDir = join(ROOT, 'tmp/dependency-security')
  mkdirSync(reportDir, { recursive: true })
  const { command, prefixArgs } = resolvePnpmCliInvocation()
  const today = new Date().toISOString().slice(0, 10)
  let passed = true
  for (const workspace of workspaces) {
    const report = { workspace, checkedAt: new Date().toISOString() }
    try {
      const result = runProcessSync({
        program: command,
        args: [
          ...prefixArgs,
          'audit',
          '--json',
          '--ignore-pnpmfile',
          '--registry=https://registry.npmjs.org'
        ],
        cwd: join(root, workspace),
        timeoutMs: 120_000,
        maxOutputBytes: 32 * 1024 * 1024
      })
      report.audit = readSecurityAudit(result)
      report.findings = evaluateSecurityAudit(report.audit, workspace, exceptions, { root, today })
      for (const item of report.findings) {
        console.log(
          `${workspace}: ${item.exception ? 'PATCHED' : item.blocking ? 'BLOCKING' : 'FINDING'} ${item.package}@${item.version} ${item.severity} ${item.advisory} ${item.url}`
        )
      }
      if (report.findings.some((item) => item.blocking)) {
        passed = false
      }
      console.log(`${workspace}: ${report.findings.length} finding(s)`)
    } catch (error) {
      report.error = error.message
      console.error(`${workspace}: ${error.message}`)
      passed = false
    }
    const name = workspace === '.' ? 'desktop' : workspace.replaceAll('/', '-')
    writeFileSync(join(reportDir, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(`Dependency reports: ${reportDir}`)
  return passed ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workspaces = process.argv.slice(3)
  if (workspaces.some((workspace) => !AUDIT_WORKSPACES.includes(workspace))) {
    throw new Error('Unknown dependency audit workspace')
  }
  process.exitCode = checkDependencySecurity(
    resolve(process.argv[2] ?? ROOT),
    workspaces.length ? workspaces : AUDIT_WORKSPACES
  )
}
