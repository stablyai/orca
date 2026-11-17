import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, parseAllDocuments } from 'yaml'
import { z } from 'zod'

export const AUDIT_WORKSPACES = ['.', 'mobile', 'cloud', 'docs/site', 'config/audit-tools']
const text = z.string().trim().min(1)
const severities = ['info', 'low', 'moderate', 'high', 'critical']
export const securityExceptions = z.array(
  z.strictObject({
    workspace: z.enum(AUDIT_WORKSPACES),
    package: text,
    version: text,
    advisory: z.string().regex(/^GHSA-[-a-z0-9]+$/),
    owner: text,
    reason: text,
    expires: z.iso.date(),
    patch: z.strictObject({ path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  })
)
const auditSchema = z.object({
  advisories: z.record(
    text,
    z.object({
      module_name: text,
      github_advisory_id: text,
      severity: z.enum(severities),
      url: z.url(),
      findings: z.array(z.object({ version: text, paths: z.array(text).min(1) })).min(1)
    })
  ),
  metadata: z.object({
    vulnerabilities: z.object(
      Object.fromEntries(severities.map((level) => [level, z.int().min(0)]))
    )
  })
})

function verifyPatch(root, exception) {
  const cwd = join(root, exception.workspace)
  const specifier = `${exception.package}@${exception.version}`
  const policy = parse(readFileSync(join(cwd, 'pnpm-workspace.yaml'), 'utf8'))
  const documents = parseAllDocuments(readFileSync(join(cwd, 'pnpm-lock.yaml'), 'utf8'))
  for (const document of documents) {
    if (document.errors.length) {
      throw document.errors[0]
    }
  }
  const lock = documents
    .map((document) => document.toJS())
    .find((value) => value?.patchedDependencies?.[specifier])
  const snapshots = Object.keys(lock?.snapshots ?? {}).filter(
    (key) => key === specifier || key.startsWith(`${specifier}(`)
  )
  if (
    policy.patchedDependencies?.[specifier] !== exception.patch.path ||
    lock?.patchedDependencies?.[specifier] !== exception.patch.sha256 ||
    snapshots.length === 0 ||
    snapshots.some((key) => !key.includes(`(patch_hash=${exception.patch.sha256})`)) ||
    createHash('sha256')
      .update(readFileSync(join(cwd, exception.patch.path)))
      .digest('hex') !== exception.patch.sha256
  ) {
    throw new Error(`Reviewed patch is not locked: ${exception.workspace} ${specifier}`)
  }
}

export function evaluateSecurityAudit(
  value,
  workspace,
  exceptions,
  { root, today = new Date().toISOString().slice(0, 10) } = {}
) {
  const audit = auditSchema.parse(value)
  const count = Object.values(audit.metadata.vulnerabilities).reduce((sum, n) => sum + n, 0)
  if (count !== Object.keys(audit.advisories).length) {
    throw new Error('Incomplete vulnerability report')
  }
  const findings = []
  for (const advisory of Object.values(audit.advisories)) {
    for (const finding of advisory.findings) {
      const item = {
        package: advisory.module_name,
        version: finding.version,
        advisory: advisory.github_advisory_id,
        severity: advisory.severity,
        url: advisory.url,
        blocking: ['high', 'critical'].includes(advisory.severity)
      }
      const exception = exceptions.find(
        (entry) =>
          entry.workspace === workspace &&
          entry.package === item.package &&
          entry.version === item.version &&
          entry.advisory === item.advisory
      )
      if (item.blocking && exception && exception.expires > today) {
        verifyPatch(root, exception)
        item.exception = exception
        item.blocking = false
      }
      findings.push(item)
    }
  }
  return findings
}
