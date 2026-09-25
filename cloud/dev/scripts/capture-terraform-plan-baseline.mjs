#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Why: the relay root can never plan zero-diff (cell templates roll one at a time by design),
// so the split is gated on plan EQUIVALENCE: the normalized change set for a root's addresses
// must be identical before and after a state move. This captures that set deterministically.
// Read-only: -lock=false, -refresh=false, no apply. Forgets from `removed` blocks are excluded
// because the baseline has none.

const usage =
  'usage: capture-terraform-plan-baseline.mjs --root <dir> --env <staging|production> --out <dir> [--tag <name>]'

export function normalizePlan(planJson) {
  const changes = (planJson.resource_changes ?? [])
    .filter((entry) => !entry.change.actions.includes('forget'))
    .map((entry) => ({
      address: entry.address,
      actions: entry.change.actions,
      before: entry.change.before ?? null,
      after: entry.change.after ?? null,
      after_unknown: entry.change.after_unknown ?? null
    }))
    .sort((left, right) => (left.address < right.address ? -1 : left.address > right.address ? 1 : 0))
  return changes
}

export function summarize(changes) {
  const counts = { create: 0, update: 0, delete: 0, replace: 0, 'no-op': 0, read: 0 }
  for (const change of changes) {
    const key = change.actions.join('-')
    if (key === 'create') counts.create += 1
    else if (key === 'update') counts.update += 1
    else if (key === 'delete') counts.delete += 1
    else if (key === 'delete-create' || key === 'create-delete') counts.replace += 1
    else if (key === 'read') counts.read += 1
    else counts['no-op'] += 1
  }
  return counts
}

function argument(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const root = argument('--root')
  const environment = argument('--env')
  const out = argument('--out')
  const tag = argument('--tag') ?? `${environment}-${root.replaceAll('/', '_')}`
  if (!root || !['staging', 'production'].includes(environment) || !out) {
    process.stderr.write(`${usage}\n`)
    process.exit(2)
  }
  // The Cloudflare override only applies to the root that still declares the records; the relay
  // root dropped them in the carve and errors on a -var for an undeclared variable.
  const declaresArtifactDns = readFileSync(join(root, 'variables.tf'), 'utf8').includes(
    'variable "manage_artifact_dns"'
  )
  mkdirSync(out, { recursive: true })
  const planFile = join(out, `${tag}.tfplan`)
  execFileSync(
    'terraform',
    [
      `-chdir=${root}`, 'plan', '-input=false', '-lock=false', '-refresh=false', '-no-color',
      `-var-file=environments/${environment}.tfvars`,
      ...(declaresArtifactDns ? ['-var', 'manage_artifact_dns=false'] : []),
      `-out=${planFile}`
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
  const json = JSON.parse(
    execFileSync('terraform', [`-chdir=${root}`, 'show', '-json', planFile], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
  )
  const normalized = normalizePlan(json)
  writeFileSync(join(out, `${tag}.norm.json`), `${JSON.stringify(normalized, null, 1)}\n`)
  process.stdout.write(`${tag}: ${JSON.stringify(summarize(normalized))}\n`)
}
