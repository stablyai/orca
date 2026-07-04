import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

import { parse, printParseErrorCode } from 'jsonc-parser'

const MANIFEST_PATH = path.join('config', 'reliability-gates.jsonc')
const RED_GREEN_STATUSES = new Set(['missing', 'partial', 'complete', 'not-required'])
const FLAKE_STATUSES = new Set(['not-started', 'unknown', 'soaking', 'stable', 'flaky'])
const PROTECTION_LEVELS = new Set(['none', 'partial', 'active'])
const EVIDENCE_RUN_RESULTS = new Set(['passed', 'failed', 'skipped'])
const EVIDENCE_RUNNERS = new Set(['local', 'ci', 'soak', 'manual'])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
}

function requireNonEmptyString(gate, field, failures) {
  if (!isNonEmptyString(gate[field])) {
    failures.push(`${gate.id ?? '<unknown>'}: ${field} must be a non-empty string`)
  }
}

function requireStringArray(gate, field, failures) {
  if (!hasNonEmptyStringArray(gate[field])) {
    failures.push(`${gate.id ?? '<unknown>'}: ${field} must be a non-empty string array`)
  }
}

function requireStringArrayAllowEmpty(gate, field, failures) {
  if (!Array.isArray(gate[field]) || !gate[field].every(isNonEmptyString)) {
    failures.push(`${gate.id ?? '<unknown>'}: ${field} must be an array of strings`)
  }
}

function requireNonNegativeNumber(record, field, owner, failures) {
  if (!Number.isFinite(record[field]) || record[field] < 0) {
    failures.push(`${owner}.${field} must be a non-negative number`)
  }
}

function validatePolicy(manifest, failures) {
  if (!isRecord(manifest.policy)) {
    failures.push('policy must be an object')
    return new Set()
  }
  if (!hasNonEmptyStringArray(manifest.policy.maturityLevels)) {
    failures.push('policy.maturityLevels must be a non-empty string array')
  }
  if (!isRecord(manifest.policy.blockingPromotion)) {
    failures.push('policy.blockingPromotion must be an object')
  } else {
    for (const field of ['minimumSoakRuns', 'minimumSoakDays', 'maximumUnexplainedFlakes']) {
      requireNonNegativeNumber(
        manifest.policy.blockingPromotion,
        field,
        'policy.blockingPromotion',
        failures
      )
    }
  }
  return new Set(
    Array.isArray(manifest.policy.maturityLevels)
      ? manifest.policy.maturityLevels.filter(isNonEmptyString)
      : []
  )
}

function validateRuntimeBudget(gate, failures) {
  if (!isRecord(gate.runtimeBudget)) {
    failures.push(`${gate.id}: runtimeBudget must be an object`)
    return
  }
  if (!Number.isFinite(gate.runtimeBudget.p95Seconds) || gate.runtimeBudget.p95Seconds <= 0) {
    failures.push(`${gate.id}: runtimeBudget.p95Seconds must be a positive number`)
  }
  if (!isNonEmptyString(gate.runtimeBudget.scope)) {
    failures.push(`${gate.id}: runtimeBudget.scope must be a non-empty string`)
  }
}

function validateEvidence(gate, field, allowedStatuses, failures) {
  const evidence = gate[field]
  if (!isRecord(evidence)) {
    failures.push(`${gate.id}: ${field} must be an object`)
    return
  }
  if (!allowedStatuses.has(evidence.status)) {
    failures.push(`${gate.id}: ${field}.status is invalid`)
  }
  if (!isNonEmptyString(evidence.evidence)) {
    failures.push(`${gate.id}: ${field}.evidence must be a non-empty string`)
  }
}

function validatePerformanceBudget(gate, failures) {
  if (!isRecord(gate.performanceBudget)) {
    failures.push(`${gate.id}: performanceBudget must be an object`)
    return
  }
  if (typeof gate.performanceBudget.required !== 'boolean') {
    failures.push(`${gate.id}: performanceBudget.required must be boolean`)
  }
  if (!isNonEmptyString(gate.performanceBudget.evidence)) {
    failures.push(`${gate.id}: performanceBudget.evidence must be a non-empty string`)
  }
}

function commandUsesBrittleTestSelector(command) {
  return /(?:^|\s)(?:-t|--testNamePattern|--grep)(?:=|\s)/.test(command)
}

function validateCommandCoverage(gate, failures) {
  if (!hasNonEmptyStringArray(gate.commands) || !hasNonEmptyStringArray(gate.testFiles)) {
    return
  }
  for (const testFile of gate.testFiles) {
    if (!gate.commands.some((command) => command.includes(testFile))) {
      failures.push(`${gate.id}: test file is not referenced by any gate command: ${testFile}`)
    }
  }
}

function validateProtection(gate, failures) {
  if (!PROTECTION_LEVELS.has(gate.protection)) {
    failures.push(`${gate.id}: protection must be one of none, partial, or active`)
    return
  }
  const hasCommands = hasNonEmptyStringArray(gate.commands)
  const hasTestFiles = hasNonEmptyStringArray(gate.testFiles)
  if (gate.protection === 'none' && (hasCommands || hasTestFiles)) {
    failures.push(`${gate.id}: protection none gates must not declare commands or testFiles`)
  }
  if (gate.protection === 'partial' && (!hasCommands || !hasTestFiles)) {
    failures.push(`${gate.id}: protection partial gates must declare commands and testFiles`)
  }
  if (gate.protection === 'active') {
    if (gate.maturity !== 'blocking') {
      failures.push(`${gate.id}: protection active is reserved for blocking gates`)
    }
    if (!hasCommands || !hasTestFiles) {
      failures.push(`${gate.id}: protection active gates must declare commands and testFiles`)
    }
    if (gate.flakeHistory?.status !== 'stable') {
      failures.push(`${gate.id}: protection active gates must have stable flakeHistory`)
    }
    if (!['complete', 'not-required'].includes(gate.redGreenEvidence?.status)) {
      failures.push(`${gate.id}: protection active gates must have complete red/green evidence`)
    }
  }
  if (!hasCommands && gate.protection !== 'none') {
    failures.push(`${gate.id}: commandless gates must declare protection none`)
  }
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function validateEvidenceRun(gate, run, index, failures) {
  const owner = `${gate.id}: evidenceRuns[${index}]`
  if (!isRecord(run)) {
    failures.push(`${owner} must be an object`)
    return
  }
  if (!isIsoDate(run.date)) {
    failures.push(`${owner}.date must be YYYY-MM-DD`)
  }
  if (!EVIDENCE_RUNNERS.has(run.runner)) {
    failures.push(`${owner}.runner must be one of local, ci, soak, or manual`)
  }
  if (!isNonEmptyString(run.platform)) {
    failures.push(`${owner}.platform must be a non-empty string`)
  }
  if (!EVIDENCE_RUN_RESULTS.has(run.result)) {
    failures.push(`${owner}.result must be one of passed, failed, or skipped`)
  }
  if (!isNonEmptyString(run.command)) {
    failures.push(`${owner}.command must be a non-empty string`)
  } else if (!gate.commands.includes(run.command)) {
    failures.push(`${owner}.command must match one of the gate commands`)
  }
  if (!Number.isFinite(run.durationSeconds) || run.durationSeconds < 0) {
    failures.push(`${owner}.durationSeconds must be a non-negative number`)
  }
  if (!isNonEmptyString(run.summary)) {
    failures.push(`${owner}.summary must be a non-empty string`)
  }
}

function validateEvidenceRuns(gate, failures) {
  if (!Array.isArray(gate.evidenceRuns)) {
    failures.push(`${gate.id}: evidenceRuns must be an array`)
    return
  }
  gate.evidenceRuns.forEach((run, index) => validateEvidenceRun(gate, run, index, failures))
  if (
    ['partial', 'active'].includes(gate.protection) &&
    !gate.evidenceRuns.some((run) => isRecord(run) && run.result === 'passed')
  ) {
    failures.push(`${gate.id}: protection ${gate.protection} gates need a passed evidence run`)
  }
  if (gate.protection === 'none' && gate.evidenceRuns.length > 0) {
    failures.push(`${gate.id}: protection none gates must not declare evidenceRuns`)
  }
}

function validateAssertionRef(gate, ref, index, failures) {
  const owner = `${gate.id}: assertionRefs[${index}]`
  if (!isRecord(ref)) {
    failures.push(`${owner} must be an object`)
    return
  }
  if (!isNonEmptyString(ref.file)) {
    failures.push(`${owner}.file must be a non-empty string`)
  } else if (!gate.testFiles.includes(ref.file)) {
    failures.push(`${owner}.file must be one of the gate testFiles`)
  }
  if (!hasNonEmptyStringArray(ref.assertions)) {
    failures.push(`${owner}.assertions must be a non-empty string array`)
  }
}

function validateAssertionRefs(gate, failures) {
  if (!Array.isArray(gate.assertionRefs)) {
    failures.push(`${gate.id}: assertionRefs must be an array`)
    return
  }
  gate.assertionRefs.forEach((ref, index) => validateAssertionRef(gate, ref, index, failures))
  if (['partial', 'active'].includes(gate.protection) && gate.assertionRefs.length === 0) {
    failures.push(`${gate.id}: protection ${gate.protection} gates need assertionRefs`)
  }
  if (gate.protection === 'none' && gate.assertionRefs.length > 0) {
    failures.push(`${gate.id}: protection none gates must not declare assertionRefs`)
  }
}

function validateCoveredScope(gate, failures) {
  requireStringArrayAllowEmpty(gate, 'coveredPlatforms', failures)
  requireStringArrayAllowEmpty(gate, 'coveredProviders', failures)
  requireNonEmptyString(gate, 'coverageNotes', failures)

  if (!Array.isArray(gate.coveredPlatforms) || !Array.isArray(gate.coveredProviders)) {
    return
  }
  for (const platform of gate.coveredPlatforms) {
    if (!gate.platforms.includes(platform)) {
      failures.push(`${gate.id}: covered platform is outside risk scope: ${platform}`)
    }
  }
  for (const provider of gate.coveredProviders) {
    if (!gate.providers.includes(provider)) {
      failures.push(`${gate.id}: covered provider is outside risk scope: ${provider}`)
    }
  }
  if (
    ['partial', 'active'].includes(gate.protection) &&
    gate.evidenceRuns.some((run) => isRecord(run) && run.result === 'passed')
  ) {
    const evidencePlatforms = new Set(
      gate.evidenceRuns
        .filter((run) => isRecord(run) && run.result === 'passed')
        .map((run) => run.platform)
    )
    for (const platform of evidencePlatforms) {
      if (!gate.coveredPlatforms.includes(platform)) {
        failures.push(
          `${gate.id}: coveredPlatforms must include passed evidence platform ${platform}`
        )
      }
    }
  }
  if (
    gate.protection === 'none' &&
    (gate.coveredPlatforms.length > 0 || gate.coveredProviders.length > 0)
  ) {
    failures.push(`${gate.id}: protection none gates must not declare covered scope`)
  }
}

async function fileExists(root, filePath) {
  try {
    const stat = await fs.stat(path.join(root, filePath))
    return stat.isFile()
  } catch {
    return false
  }
}

async function validateGate(gate, maturities, root) {
  const failures = []
  if (!isRecord(gate)) {
    return ['gate entry must be an object']
  }
  for (const field of ['id', 'title', 'owner', 'layer', 'invariant', 'oracle', 'demotionRule']) {
    requireNonEmptyString(gate, field, failures)
  }
  if (!maturities.has(gate.maturity)) {
    failures.push(`${gate.id ?? '<unknown>'}: maturity is invalid`)
  }
  for (const field of [
    'surfaces',
    'platforms',
    'providers',
    'motivatingLinks',
    'promotionCriteria'
  ]) {
    requireStringArray(gate, field, failures)
  }
  if (!Array.isArray(gate.commands) || !gate.commands.every(isNonEmptyString)) {
    failures.push(`${gate.id}: commands must be an array of strings`)
  } else if (gate.commands.some(commandUsesBrittleTestSelector)) {
    failures.push(
      `${gate.id}: commands must not rely on title selectors (-t, --grep, or --testNamePattern)`
    )
  }
  if (!Array.isArray(gate.testFiles) || !gate.testFiles.every(isNonEmptyString)) {
    failures.push(`${gate.id}: testFiles must be an array of strings`)
  } else {
    for (const testFile of gate.testFiles) {
      if (!(await fileExists(root, testFile))) {
        failures.push(`${gate.id}: test file does not exist: ${testFile}`)
      }
    }
  }
  validateCommandCoverage(gate, failures)
  if (['soak', 'blocking'].includes(gate.maturity)) {
    if (!hasNonEmptyStringArray(gate.commands)) {
      failures.push(`${gate.id}: ${gate.maturity} gates must declare at least one command`)
    }
    if (!hasNonEmptyStringArray(gate.testFiles)) {
      failures.push(`${gate.id}: ${gate.maturity} gates must declare at least one test file`)
    }
    if (!['soaking', 'stable'].includes(gate.flakeHistory?.status)) {
      failures.push(`${gate.id}: ${gate.maturity} gates must have soaking or stable flakeHistory`)
    }
    if (!['complete', 'not-required'].includes(gate.redGreenEvidence?.status)) {
      failures.push(`${gate.id}: ${gate.maturity} gates must have complete red/green evidence`)
    }
  }
  validateRuntimeBudget(gate, failures)
  validateEvidence(gate, 'flakeHistory', FLAKE_STATUSES, failures)
  validateEvidence(gate, 'redGreenEvidence', RED_GREEN_STATUSES, failures)
  validateProtection(gate, failures)
  validateEvidenceRuns(gate, failures)
  validateAssertionRefs(gate, failures)
  validateCoveredScope(gate, failures)
  validatePerformanceBudget(gate, failures)
  if (!Array.isArray(gate.knownGaps) || !gate.knownGaps.every(isNonEmptyString)) {
    failures.push(`${gate.id}: knownGaps must be an array of strings`)
  }
  return failures
}

export async function main(root = process.cwd()) {
  const manifestPath = path.join(root, MANIFEST_PATH)
  let raw
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`${MANIFEST_PATH}: unable to read manifest (${message})`)
    return 1
  }
  const parseErrors = []
  const manifest = parse(raw, parseErrors, { allowTrailingComma: true })
  if (parseErrors.length > 0) {
    for (const error of parseErrors) {
      console.error(
        `${MANIFEST_PATH}: JSONC parse error ${printParseErrorCode(error.error)} at offset ${error.offset}`
      )
    }
    return 1
  }
  const failures = []
  if (!isRecord(manifest)) {
    failures.push('manifest must be an object')
  } else {
    if (manifest.schemaVersion !== 1) {
      failures.push('schemaVersion must be 1')
    }
    const maturities = validatePolicy(manifest, failures)
    if (!Array.isArray(manifest.gates) || manifest.gates.length === 0) {
      failures.push('gates must be a non-empty array')
    } else {
      const seenIds = new Set()
      for (const gate of manifest.gates) {
        if (isRecord(gate) && isNonEmptyString(gate.id)) {
          if (seenIds.has(gate.id)) {
            failures.push(`${gate.id}: duplicate gate id`)
          }
          seenIds.add(gate.id)
        }
        failures.push(...(await validateGate(gate, maturities, root)))
      }
    }
  }
  if (failures.length > 0) {
    console.error(`Reliability gate manifest check failed with ${failures.length} issue(s):`)
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    return 1
  }
  console.log(`Reliability gate manifest check passed for ${manifest.gates.length} gate(s).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
