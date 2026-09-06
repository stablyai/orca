// Derives, from workflow and script content, which workflows roll out against the shared Cloud SQL
// instance. Hand lists go stale silently; everything here is read back off disk.
import { readFileSync, readdirSync } from 'node:fs'
import {
  RELAY_WORKFLOW_DIRECTORY,
  RELAY_WORKFLOW_FILE_PREFIX,
  relayWorkflowFile
} from './relay-repository.mjs'

export const WORKFLOW_ROOT = RELAY_WORKFLOW_DIRECTORY
export const SCRIPT_ROOT = new URL('./', import.meta.url)

export const LEASE_ACTION = './.github/actions/cloud-sql-rollout-lease'
export const PRODUCTION_LEASE = {
  bucket: 'onorca-cloud-terraform-state',
  object: 'terraform/state/cloud-sql-rollout/production.lock'
}
export const STAGING_LEASE = {
  bucket: 'onorca-cloud-staging-terraform-state',
  object: 'terraform/state/cloud-sql-rollout/staging.lock'
}

export const PRODUCTION_GROUP = 'production-cloud-sql-rollout'
export const STAGING_GROUP = 'relay-staging-mutation'
export const SELECTABLE_GROUP =
  "${{ inputs.environment == 'production' && 'production-cloud-sql-rollout' || 'relay-staging-mutation' }}"

const selectable = (production, staging) =>
  `\${{ inputs.environment == 'production' && '${production}' || '${staging}' }}`

export const SELECTABLE_LEASE = {
  bucket: selectable(PRODUCTION_LEASE.bucket, STAGING_LEASE.bucket),
  object: selectable(PRODUCTION_LEASE.object, STAGING_LEASE.object)
}

export const LOCK_GROUPS = new Set([PRODUCTION_GROUP, STAGING_GROUP, SELECTABLE_GROUP])

export function readWorkflow(file) {
  return readFileSync(new URL(file, WORKFLOW_ROOT), 'utf8')
}

export function workflowFiles() {
  return readdirSync(WORKFLOW_ROOT)
    .filter((name) => name.endsWith('.yml') && name.startsWith(RELAY_WORKFLOW_FILE_PREFIX))
    .sort()
}

// --- YAML-shaped readers (line based; the workflows are hand-written and uniformly indented) ---

function indentOf(line) {
  return line.length - line.trimStart().length
}

function blockAfter(lines, index) {
  const base = indentOf(lines[index])
  const body = []
  for (let i = index + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') {
      body.push(lines[i])
      continue
    }
    if (indentOf(lines[i]) <= base) break
    body.push(lines[i])
  }
  return body
}

export function concurrencyBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  lines.forEach((line, index) => {
    if (line.trim() !== 'concurrency:') return
    const body = blockAfter(lines, index)
    blocks.push({
      group: body.find((l) => l.trim().startsWith('group:'))?.trim().slice('group:'.length).trim(),
      cancelInProgress: body
        .find((l) => l.trim().startsWith('cancel-in-progress:'))
        ?.trim()
        .slice('cancel-in-progress:'.length)
        .trim()
    })
  })
  return blocks
}

export function jobs(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === 'jobs:')
  if (start === -1) return []
  const found = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i])
    if (!match) continue
    found.push({ id: match[1], start: i, body: blockAfter(lines, i) })
  }
  return found.map((job) => ({ ...job, text: job.body.join('\n') }))
}

function scalarField(jobText, key) {
  const lines = jobText.split('\n')
  const index = lines.findIndex((line) => /^ {4}[A-Za-z-]+:/.test(line) && line.trim().startsWith(`${key}:`))
  if (index === -1) return undefined
  const inline = lines[index].trim().slice(`${key}:`.length).trim()
  if (inline !== '' && inline !== '>-' && inline !== '|') return inline
  return blockAfter(lines, index).join(' ').replace(/\s+/g, ' ').trim()
}

export function jobNeeds(jobText) {
  const raw = scalarField(jobText, 'needs')
  if (!raw) return []
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[,\n]|\s+-\s+/)
    .map((entry) => entry.replace(/^-/, '').trim())
    .filter(Boolean)
}

export function jobIf(jobText) {
  return scalarField(jobText, 'if') ?? ''
}

export function leaseSteps(text) {
  const lines = text.split('\n')
  const steps = []
  lines.forEach((line, index) => {
    if (line.trim() !== `- uses: ${LEASE_ACTION}`) return
    const body = blockAfter(lines, index)
    const read = (key) =>
      body.find((l) => l.trim().startsWith(`${key}:`))?.trim().slice(`${key}:`.length).trim()
    steps.push({
      line: index + 1,
      bucket: read('bucket'),
      object: read('object'),
      release: read('release')
    })
  })
  return steps
}

export function leaseStepsByJob(file) {
  const text = readWorkflow(file)
  const steps = leaseSteps(text)
  return jobs(text).map((job) => ({
    id: job.id,
    steps: steps.filter((step) => step.line > job.start + 1 && step.line <= job.start + 1 + job.body.length)
  }))
}

// --- trigger and reusable-call graph ---

export function triggers(text) {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line === 'on:')
  if (index === -1) return []
  return blockAfter(lines, index)
    .map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1])
    .filter(Boolean)
}

export function isEntrypoint(text) {
  return triggers(text).some((trigger) => trigger !== 'workflow_call')
}

export function reusableCalls(text) {
  const counts = new Map()
  for (const match of text.matchAll(/uses: \.\/\.github\/workflows\/([A-Za-z0-9._-]+\.yml)/g)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
  }
  return counts
}

export function entrypointsFor(file, seen = new Set()) {
  if (seen.has(file)) return new Set()
  seen.add(file)
  if (isEntrypoint(readWorkflow(file))) return new Set([file])
  const reached = new Set()
  for (const candidate of workflowFiles()) {
    if (candidate === file) continue
    if (!reusableCalls(readWorkflow(candidate)).has(file)) continue
    for (const entry of entrypointsFor(candidate, seen)) reached.add(entry)
  }
  return reached
}

// --- what counts as a Cloud SQL connection-budget rollout ---

const COMMAND_PREFIX = /^(?:-\s+)?(?:run:\s*)?(?:[a-z_]+\s*=\s*"?\$\(\s*)?(?:if\s+|then\s+|else\s+|&&\s+|\|\|\s+|!\s+)*/

function commandLines(text) {
  return text.split('\n').map((line) => line.trim().replace(COMMAND_PREFIX, ''))
}

export function appliesTerraform(text) {
  return commandLines(text).some((line) => /^terraform\b.*\bapply\b/.test(line))
}

export function runsCloudRunMutation(text) {
  return commandLines(text).some((line) =>
    /^gcloud run (?:deploy\b|services (?:update|replace)\b|jobs (?:update|deploy)\b)/.test(line)
  )
}

// Scripts that mint a Cloud Run revision, plus every script that re-exports one of them.
export function revisionMintingScripts() {
  const self = new URL(import.meta.url).pathname.split('/').pop()
  const names = readdirSync(SCRIPT_ROOT).filter(
    (name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && name !== self
  )
  const source = new Map(
    names.map((name) => [name, readFileSync(new URL(name, SCRIPT_ROOT), 'utf8')])
  )
  const minting = new Set(
    names.filter((name) => {
      const text = source.get(name)
      return (
        text.includes("'--no-traffic'") ||
        /'run',\s*'services',\s*'update'/.test(text) ||
        /'run',\s*'deploy'/.test(text)
      )
    })
  )
  for (let changed = true; changed; ) {
    changed = false
    for (const name of names) {
      if (minting.has(name)) continue
      const imports = [...source.get(name).matchAll(/from '\.\/([A-Za-z0-9._-]+\.mjs)'/g)].map(
        (match) => match[1]
      )
      if (!imports.some((imported) => minting.has(imported))) continue
      minting.add(name)
      changed = true
    }
  }
  return minting
}

export function mutatesSharedInstance(text, minters = revisionMintingScripts()) {
  if (appliesTerraform(text)) return 'terraform apply against the reviewed relay cell templates'
  if (runsCloudRunMutation(text)) return 'gcloud mints or replaces a Cloud Run revision'
  for (const script of minters) {
    if (text.includes(`dev/scripts/${script}`)) return `runs ${script}, which mints a Cloud Run revision`
  }
  return undefined
}

// --- the declared contract ---

const production = (extra = {}) => ({ env: 'production', group: PRODUCTION_GROUP, ...extra })
const staging = (extra = {}) => ({ env: 'staging', group: STAGING_GROUP, ...extra })
const eitherEnvironment = () => ({ env: 'selectable', group: SELECTABLE_GROUP })

// Keys are workflow filenames, which the public copy prefixes; the prefix lives in one place.
const named = (entries) =>
  Object.fromEntries(
    entries.map(([file, entry]) => [
      relayWorkflowFile(file),
      entry.leaseFiles
        ? { ...entry, leaseFiles: entry.leaseFiles.map((member) => relayWorkflowFile(member)) }
        : entry
    ])
  )

export const LEASED_WORKFLOWS = named([
  ['deploy-relay-fence-broker.yml', production()],
  ['deploy-relay-production.yml', production()],
  ['deploy-relay-production-director.yml', production()],
  ['deploy-relay-production-multi-target.yml', production()],
  [
    'deploy-relay-production-capacity.yml',
    production({
      leaseFiles: ['deploy-relay-production-capacity-job.yml'],
      reentrant: true
    })
  ],
  [
    'deploy-relay-production-same-cap.yml',
    production({
      leaseFiles: ['deploy-relay-production-same-cap-job.yml'],
      reentrant: true
    })
  ],
  [
    'operate-relay-production-rehome.yml',
    production({ leaseFiles: ['operate-relay-production-rehome-job.yml'] })
  ],
  ['deploy-relay-asia-topology.yml', eitherEnvironment()],
  ['operate-relay-asia-admission.yml', eitherEnvironment()],
  ['deploy-relay-staging.yml', staging()],
  ['deploy-relay-staging-gce-candidate.yml', staging()],
  ['bootstrap-relay-staging-capacity.yml', staging()],
  ['power-relay-staging.yml', staging()],
  ['prove-relay-asia-staging.yml', staging()],
  [
    'prove-relay-staging-capacity.yml',
    staging({ exclusiveBy: "inputs.mode == 'refresh-asia-c4-image'" })
  ],
  ['recover-relay-staging-c4-image.yml', staging()]
])

export const NOT_A_CLOUD_SQL_CANDIDATE = named([
  [
    'monitor-relay-production.yml',
    'Read-only. Its identity holds monitoring, logging, Cloud SQL and compute viewer roles only, and it runs `gcloud sql instances describe`, never a mutation. It consumes no connection budget, so the durable lease would only let monitoring block a rollout and a rollout block monitoring.'
  ]
])
