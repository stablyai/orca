import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIG_ADDRESS_PREFIX = 'google_compute_instance_group_manager.relay_gce_cell'
const PLAN_OBJECT_PREFIX = 'terraform/state/relay-fence-plans'
const TERRAFORM_STATE_LINEAGE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const GENERATED_MIG_VERSION_NAME =
  /^0\/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?\+00:00$/

function changedActions(change) {
  return change.change.actions.filter((action) => action !== 'no-op' && action !== 'read')
}

export function validateTerraformFencePlan(plan, expected) {
  const changes = (plan.resource_changes ?? []).filter(
    (change) => changedActions(change).length > 0
  )
  if (changes.length !== 1) throw new Error('fence plan must contain exactly one mutation')
  const [change] = changes
  if (change.address !== `${MIG_ADDRESS_PREFIX}["${expected.cellId}"]`) {
    throw new Error('fence plan mutates an unexpected resource')
  }
  if (
    JSON.stringify(change.change.actions) !== JSON.stringify(['update']) ||
    Number(change.change.before?.target_size) !== 1 ||
    Number(change.change.after?.target_size) !== 0
  ) {
    throw new Error('fence plan must update only the requested MIG from one to zero')
  }
  for (const field of ['name', 'zone', 'instance_group']) {
    if (
      change.change.before?.[field] !== change.change.after?.[field] ||
      change.change.after?.[field] !== expected[field]
    ) {
      throw new Error(`fence plan changed or mismatched MIG ${field}`)
    }
  }
  const beforeGeneration = change.change.before?.version?.[0]?.instance_template
  const afterGeneration = change.change.after?.version?.[0]?.instance_template
  if (
    beforeGeneration !== afterGeneration ||
    afterGeneration !== expected.generationIdentity
  ) {
    throw new Error('fence plan changed or mismatched the MIG generation')
  }
  return change
}

export function validateTerraformFenceCompletionPlan(plan, expected) {
  const changes = (plan.resource_changes ?? []).filter(
    (change) => changedActions(change).length > 0
  )
  if (changes.length === 0) return
  if (changes.length !== 1) {
    throw new Error('completed fence plan contains an unexpected mutation')
  }
  const [change] = changes
  const before = change.change.before
  const after = change.change.after
  const beforeVersion = before?.version?.[0]
  const afterVersion = after?.version?.[0]
  if (
    change.address !== `${MIG_ADDRESS_PREFIX}["${expected.cellId}"]` ||
    JSON.stringify(change.change.actions) !== JSON.stringify(['update']) ||
    Number(before?.target_size) !== 0 ||
    Number(after?.target_size) !== 0 ||
    before?.name !== expected.name ||
    after?.name !== expected.name ||
    before?.zone !== expected.zone ||
    after?.zone !== expected.zone ||
    before?.instance_group !== expected.instance_group ||
    after?.instance_group !== expected.instance_group ||
    before?.version?.length !== 1 ||
    after?.version?.length !== 1 ||
    beforeVersion?.instance_template !== expected.generationIdentity ||
    afterVersion?.instance_template !== expected.generationIdentity ||
    !GENERATED_MIG_VERSION_NAME.test(beforeVersion?.name ?? '') ||
    afterVersion?.name !== 'primary'
  ) {
    throw new Error('completed fence plan is not a safe provider normalization')
  }
  const normalizedBefore = structuredClone(before)
  normalizedBefore.version[0].name = afterVersion.name
  if (JSON.stringify(normalizedBefore) !== JSON.stringify(after)) {
    throw new Error('completed fence plan changes more than the provider version label')
  }
  return change
}

export function terraformFenceState(state, expected) {
  const resources = state.values?.root_module?.resources ?? []
  const matches = resources.filter(
    (resource) => resource.address === `${MIG_ADDRESS_PREFIX}["${expected.cellId}"]`
  )
  if (matches.length !== 1) throw new Error('Terraform state has no unique requested MIG')
  const values = matches[0].values
  if (
    values.name !== expected.name ||
    values.zone !== expected.zone ||
    values.instance_group !== expected.instance_group ||
    values.version?.[0]?.instance_template !== expected.generationIdentity
  ) {
    throw new Error('Terraform state MIG identity does not match the reviewed topology')
  }
  const targetSize = Number(values.target_size)
  if (![0, 1].includes(targetSize)) throw new Error('Terraform state MIG size is unsafe')
  return targetSize
}

export function classifyTerraformFenceProgress({
  stateTargetSize,
  liveTargetSize,
  instanceCount,
  operationStatus,
  operationError = false,
  operationAuditBound = false
}) {
  if (operationError) throw new Error('Terraform fence GCE operation failed')
  if (operationStatus === 'DONE' && !operationAuditBound) {
    throw new Error('Terraform fence GCE operation lacks exact audit binding')
  }
  if (
    stateTargetSize === 0 &&
    liveTargetSize === 0 &&
    instanceCount === 0 &&
    operationStatus === 'DONE'
  ) {
    return 'complete'
  }
  if (
    [0, 1].includes(stateTargetSize) &&
    [0, 1].includes(liveTargetSize) &&
    ['PENDING', 'RUNNING'].includes(operationStatus)
  ) {
    return 'in-progress'
  }
  if (
    stateTargetSize === 1 &&
    liveTargetSize === 0 &&
    instanceCount === 0 &&
    operationStatus === 'DONE'
  ) {
    return 'reconcile-state'
  }
  if (
    stateTargetSize === 1 &&
    liveTargetSize === 1 &&
    instanceCount === 1 &&
    operationStatus === 'ABSENT'
  ) {
    return 'not-started'
  }
  throw new Error('Terraform fence progress is ambiguous or unsafe')
}

function sha256(path, readFile) {
  return createHash('sha256').update(readFile(path)).digest('hex')
}

function terraformJson(deps, args) {
  return JSON.parse(deps.terraform(args, { encoding: 'utf8' }))
}

export function terraformProcessStdio(options = {}) {
  if (!options.encoding) return 'inherit'
  return [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
}

function defaultTerraform(args, options = {}) {
  return execFileSync(process.env.IAC_TOOL || 'terraform', args, {
    ...options,
    stdio: terraformProcessStdio(options)
  })
}

function defaultGit(args, options = {}) {
  return execFileSync('git', args, {
    ...options,
    stdio: options.encoding ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
}

function privatePlanDirectory(deps) {
  const previousMask = process.umask(0o077)
  try {
    const directory = deps.mkdtemp(join(deps.tmpdir(), 'orca-relay-fence-'))
    deps.chmod(directory, 0o700)
    return directory
  } finally {
    process.umask(previousMask)
  }
}

function exactMigExpected(cell) {
  return {
    cellId: cell.cellId,
    name: cell.migName,
    zone: cell.zone,
    instance_group: cell.instanceGroup,
    generationIdentity: cell.generationIdentity
  }
}

function assertFenceIdentity(cell) {
  if (!cell.generationIdentity) throw new Error('requested cell has no generation identity')
}

function assertAttemptMatches(config, attempt, requirePlanGeneration = true) {
  for (const [field, expected] of Object.entries({
    environment: config.environment,
    cellId: config.cell.cellId,
    cellIncarnation: config.cellIncarnation,
    migName: config.cell.migName,
    instanceGroup: config.cell.instanceGroup,
    generationIdentity: config.cell.generationIdentity,
    fenceCommit: config.fenceCommit
  })) {
    if (attempt[field] !== expected) throw new Error(`fence attempt ${field} mismatch`)
  }
  if (!/^[a-f0-9]{64}$/.test(attempt.planSha256 ?? '')) {
    throw new Error('fence attempt has no valid saved-plan digest')
  }
  if (
    attempt.planObjectName !==
    `${PLAN_OBJECT_PREFIX}/${config.environment}/${attempt.attemptId}.tfplan`
  ) {
    throw new Error('fence attempt saved-plan object mismatch')
  }
  if (
    requirePlanGeneration &&
    !/^[1-9][0-9]{0,30}$/.test(attempt.planObjectGeneration ?? '')
  ) {
    throw new Error('fence attempt has no valid saved-plan generation')
  }
  if (!/^[a-f0-9]{64}$/.test(attempt.varFileSha256 ?? '')) {
    throw new Error('fence attempt has no valid variable-file digest')
  }
  if (
    !TERRAFORM_STATE_LINEAGE.test(attempt.terraformStateLineage ?? '') ||
    !Number.isSafeInteger(attempt.terraformStateSerial) ||
    attempt.terraformStateSerial < 0
  ) {
    throw new Error('fence attempt has no valid Terraform state identity')
  }
  if (
    !/^[1-9][0-9]{0,30}$/.test(
      attempt.terraformStateObjectGeneration ?? ''
    ) ||
    !/^[a-f0-9]{64}$/.test(attempt.terraformStateObjectSha256 ?? '')
  ) {
    throw new Error('fence attempt has no valid Terraform state object binding')
  }
  if (attempt.requestReason !== `orca-relay-fence/${attempt.attemptId}`) {
    throw new Error('fence attempt request-reason mismatch')
  }
}

export function terraformFenceStateIdentity(config, deps = {}) {
  const terraform = deps.terraform ?? defaultTerraform
  const state = terraformJson({ terraform }, [
    `-chdir=${config.terraformDir}`,
    'state',
    'pull'
  ])
  if (
    !TERRAFORM_STATE_LINEAGE.test(state.lineage ?? '') ||
    !Number.isSafeInteger(state.serial) ||
    state.serial < 0
  ) {
    throw new Error('Terraform state has no valid lineage or serial')
  }
  return { lineage: state.lineage, serial: state.serial }
}

export function assertReviewedFenceCheckout(config, deps = {}) {
  const environment = deps.environment ?? process.env
  const git = deps.git ?? defaultGit
  const readFile = deps.readFile ?? readFileSync
  const varPath = join(config.terraformDir, config.varFile)
  const imageCommit = environment.ORCA_RELAY_FENCE_IMAGE_COMMIT
  if (imageCommit !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(imageCommit) || imageCommit !== config.fenceCommit) {
      throw new Error('fence commit does not match immutable broker image')
    }
    return sha256(varPath, readFile)
  }
  const head = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (head !== config.fenceCommit) throw new Error('fence commit does not match checked-out HEAD')
  const status = git(['status', '--porcelain=v1', '--untracked-files=no'], {
    encoding: 'utf8'
  }).trim()
  if (status) throw new Error('Terraform fence requires a clean checkout')
  const terraformStatus = git(
    ['status', '--porcelain=v1', '--untracked-files=all', '--', config.terraformDir],
    { encoding: 'utf8' }
  ).trim()
  if (terraformStatus) throw new Error('Terraform fence directory contains unreviewed files')
  git(['ls-files', '--error-unmatch', '--', varPath], { encoding: 'utf8' })
  return sha256(varPath, readFile)
}

function assertAttemptCheckoutBinding(config, attempt, deps) {
  const digest = assertReviewedFenceCheckout(config, deps)
  if (digest !== attempt.varFileSha256) {
    throw new Error('reviewed Terraform variable-file digest changed')
  }
}

function assertReplayStateIdentity(progress, attempt) {
  if (
    progress.stateLineage !== attempt.terraformStateLineage ||
    progress.stateSerial !== attempt.terraformStateSerial
  ) {
    throw new Error('Terraform state lineage or serial changed before saved-plan replay')
  }
}

function assertStateObjectBinding(binding, attempt) {
  if (
    binding.generation !== attempt.terraformStateObjectGeneration ||
    binding.sha256 !== attempt.terraformStateObjectSha256 ||
    binding.lineage !== attempt.terraformStateLineage ||
    binding.serial !== attempt.terraformStateSerial
  ) {
    throw new Error('Terraform pre-state object generation or digest changed')
  }
}

function completedStateBranch(progress, attempt) {
  if (progress.stateLineage !== attempt.terraformStateLineage) {
    throw new Error('completed Terraform fence state identity is unexpected')
  }
  if (progress.stateSerial === attempt.terraformStateSerial) return 'replay'
  if (progress.stateSerial === attempt.terraformStateSerial + 1) return 'complete'
  throw new Error('completed Terraform fence state identity is unexpected')
}

async function persistInvocationOperations(attempt, progress, markOperation) {
  let updated = attempt
  for (const observed of progress.invocationOperations ?? []) {
    const recorded = (updated.applyInvocations ?? []).find(
      (value) => value.invocationId === observed.invocationId
    )
    if (!observed.gceOperation || recorded?.gceOperation) continue
    const marked = await markOperation(
      { ...updated, gceOperation: observed.gceOperation },
      observed
    )
    updated = {
      ...marked.attempt,
      applyInvocations: (updated.applyInvocations ?? []).map((value) =>
        value.invocationId === marked.invocation.invocationId
          ? marked.invocation
          : value
      )
    }
  }
  return updated
}

export function assertTerraformFenceZeroDiff(config, deps = {}) {
  const terraform = deps.terraform ?? defaultTerraform
  const directory = privatePlanDirectory({
    mkdtemp: deps.mkdtemp ?? mkdtempSync,
    chmod: deps.chmod ?? chmodSync,
    tmpdir: deps.tmpdir ?? tmpdir
  })
  const planPath = join(directory, 'completion.tfplan')
  try {
    terraform(
      [
        `-chdir=${config.terraformDir}`,
        'plan',
        '-input=false',
        '-refresh=false',
        `-lock-timeout=${config.lockTimeout}`,
        `-var-file=${config.varFile}`,
        `-target=${MIG_ADDRESS_PREFIX}["${config.cell.cellId}"]`,
        `-out=${planPath}`,
        '-no-color'
      ],
      { encoding: 'utf8' }
    )
    const plan = terraformJson({ terraform }, [
      `-chdir=${config.terraformDir}`,
      'show',
      '-json',
      planPath
    ])
    validateTerraformFenceCompletionPlan(plan, exactMigExpected(config.cell))
  } catch {
    throw new Error('completed Terraform fence has an unsafe reviewed diff')
  } finally {
    ;(deps.remove ?? rmSync)(directory, { recursive: true, force: true })
  }
}

export function assertTerraformFenceStateFenced(config, deps = {}) {
  const terraform = deps.terraform ?? defaultTerraform
  const state = terraformJson({ terraform }, [
    `-chdir=${config.terraformDir}`,
    'show',
    '-json'
  ])
  if (terraformFenceState(state, exactMigExpected(config.cell)) !== 0) {
    throw new Error('Terraform state does not record the requested cell fence')
  }
}

export async function adoptLegacyTerraformFence(config, deps) {
  for (const dependency of [
    'loadAttempt',
    'assertCommittedFenceSet',
    'assertStateFenced',
    'preApplyGuard',
    'postApplyGuard',
    'attest',
    'commitAdoption'
  ]) {
    if (typeof deps[dependency] !== 'function') throw new Error(`missing ${dependency} dependency`)
  }
  assertFenceIdentity(config.cell)
  assertReviewedFenceCheckout(config, deps)
  if (await deps.loadAttempt()) {
    throw new Error('legacy Terraform fence adoption requires no durable attempt')
  }
  await deps.assertCommittedFenceSet()
  await deps.preApplyGuard()
  await deps.assertStateFenced()
  await deps.postApplyGuard(config.cellIncarnation)
  if (await deps.loadAttempt()) {
    throw new Error('durable fence attempt appeared during legacy adoption')
  }
  await deps.attest(config.cellIncarnation)
  await deps.postApplyGuard(config.cellIncarnation)
  await deps.commitAdoption(config.cellIncarnation)
  deps.emit?.({
    event: 'terraform_cell_fence_legacy_adopted',
    cellId: config.cell.cellId
  })
}

function planObjectUri(config, attempt) {
  return `gs://${config.project}-terraform-state/${attempt.planObjectName}`
}

export async function readTerraformStateObjectBinding(
  config,
  deps,
  statePath
) {
  const uri = `gs://${config.project}-terraform-state/terraform/state/default.tfstate`
  const metadata = deps.commandJson([
    'storage',
    'objects',
    'describe',
    uri,
    '--format=json'
  ])
  const generation = String(metadata.generation ?? '')
  if (!/^[1-9][0-9]{0,30}$/.test(generation)) {
    throw new Error('Terraform state object has no valid generation')
  }
  deps.command([
    'storage',
    'cp',
    `${uri}#${generation}`,
    statePath,
    `--if-generation-match=${generation}`,
    '--quiet'
  ])
  ;(deps.chmod ?? chmodSync)(statePath, 0o600)
  const contents = (deps.readFile ?? readFileSync)(statePath)
  const state = JSON.parse(contents.toString())
  if (
    !TERRAFORM_STATE_LINEAGE.test(state.lineage ?? '') ||
    !Number.isSafeInteger(state.serial) ||
    state.serial < 0
  ) {
    throw new Error('Terraform state object identity is invalid')
  }
  return {
    generation,
    sha256: createHash('sha256').update(contents).digest('hex'),
    lineage: state.lineage,
    serial: state.serial
  }
}

export async function uploadTerraformFencePlan(config, deps, planPath, attempt) {
  const uri = planObjectUri(config, attempt)
  deps.command([
    'storage',
    'cp',
    planPath,
    uri,
    '--if-generation-match=0',
    '--quiet'
  ])
  const metadata = deps.commandJson([
    'storage',
    'objects',
    'describe',
    uri,
    '--format=json'
  ])
  const generation = String(metadata.generation ?? '')
  if (!/^[1-9][0-9]{0,30}$/.test(generation)) {
    throw new Error('uploaded fence plan has no valid object generation')
  }
  return { generation }
}

export async function resolveTerraformFencePlanGeneration(config, deps, attempt) {
  const result = deps.commandResult([
    'storage',
    'objects',
    'describe',
    planObjectUri(config, attempt),
    '--format=value(generation)'
  ])
  if (result.status !== 0) {
    if (/(?:404|not found|no urls matched)/i.test(result.stderr ?? '')) {
      return { generation: null }
    }
    throw new Error('durable fence plan object could not be inspected')
  }
  const generation = String(result.stdout ?? '').trim()
  if (!/^[1-9][0-9]{0,30}$/.test(generation)) {
    throw new Error('durable fence plan has no valid object generation')
  }
  return { generation }
}

export async function downloadTerraformFencePlan(config, deps, attempt, planPath) {
  const uri = `${planObjectUri(config, attempt)}#${attempt.planObjectGeneration}`
  deps.command([
    'storage',
    'cp',
    uri,
    planPath,
    `--if-generation-match=${attempt.planObjectGeneration}`,
    '--quiet'
  ])
  ;(deps.chmod ?? chmodSync)(planPath, 0o600)
}

export async function deleteTerraformFencePlan(config, deps, attempt) {
  const result = deps.commandResult([
    'storage',
    'rm',
    `${planObjectUri(config, attempt)}#${attempt.planObjectGeneration}`,
    `--if-generation-match=${attempt.planObjectGeneration}`,
    '--quiet'
  ])
  if (result.status === 0) return
  if (/(?:404|not found|no urls matched)/i.test(result.stderr ?? '')) return
  throw new Error('exact Terraform fence plan generation could not be deleted')
}

export async function runTerraformFenceApply(config, overrides = {}) {
  const terraform = overrides.terraform ?? defaultTerraform
  const deps = {
    terraform,
    git: overrides.git ?? defaultGit,
    mkdtemp: overrides.mkdtemp ?? mkdtempSync,
    chmod: overrides.chmod ?? chmodSync,
    tmpdir: overrides.tmpdir ?? tmpdir,
    readFile: overrides.readFile ?? readFileSync,
    remove: overrides.remove ?? rmSync,
    stat: overrides.stat ?? statSync,
    randomUUID: overrides.randomUUID ?? randomUUID,
    inspectProgress: overrides.inspectProgress,
    prepareAttempt: overrides.prepareAttempt,
    bindPlan: overrides.bindPlan,
    markApplyStarted: overrides.markApplyStarted,
    markOperation: overrides.markOperation,
    attest: overrides.attest,
    uploadPlan: overrides.uploadPlan,
    deletePlan: overrides.deletePlan,
    stateObjectBinding: overrides.stateObjectBinding,
    assertZeroDiff:
      overrides.assertZeroDiff ??
      (async () => assertTerraformFenceZeroDiff(config, { terraform })),
    preApplyGuard: overrides.preApplyGuard,
    postApplyGuard: overrides.postApplyGuard,
    assertCommittedFenceSet:
      overrides.assertCommittedFenceSet ??
      (() => assertTerraformFenceSet(config, { terraform })),
    emit: overrides.emit ?? (() => {})
  }
  for (const dependency of [
    'inspectProgress',
    'prepareAttempt',
    'bindPlan',
    'markApplyStarted',
    'markOperation',
    'attest',
    'uploadPlan',
    'deletePlan',
    'stateObjectBinding',
    'assertZeroDiff',
    'preApplyGuard',
    'postApplyGuard'
  ]) {
    if (typeof deps[dependency] !== 'function') throw new Error(`missing ${dependency} dependency`)
  }
  assertFenceIdentity(config.cell)
  const varFileSha256 = assertReviewedFenceCheckout(config, deps)
  await deps.assertCommittedFenceSet()
  const expected = exactMigExpected(config.cell)
  const directory = privatePlanDirectory(deps)
  const planPath = join(directory, 'fence.tfplan')
  try {
    const initialProgress = await deps.inspectProgress(expected, null)
    if (classifyTerraformFenceProgress(initialProgress) !== 'not-started') {
      throw new Error('Terraform fence is not in the exact initial live state')
    }
    const stateBinding = await deps.stateObjectBinding(
      join(directory, 'pre-state.tfstate')
    )
    deps.terraform([
      `-chdir=${config.terraformDir}`,
      'plan',
      '-input=false',
      '-refresh=false',
      `-lock-timeout=${config.lockTimeout}`,
      `-var-file=${config.varFile}`,
      `-target=${MIG_ADDRESS_PREFIX}["${config.cell.cellId}"]`,
      `-out=${planPath}`
    ])
    deps.chmod(planPath, 0o600)
    const postPlanStateBinding = await deps.stateObjectBinding(
      join(directory, 'post-plan-state.tfstate')
    )
    if (
      JSON.stringify(postPlanStateBinding) !== JSON.stringify(stateBinding)
    ) {
      throw new Error('Terraform state object changed while creating the fence plan')
    }
    if ((deps.stat(planPath).mode & 0o077) !== 0) {
      throw new Error('saved fence plan permissions are not private')
    }
    const plan = terraformJson(deps, [
      `-chdir=${config.terraformDir}`,
      'show',
      '-json',
      planPath
    ])
    validateTerraformFencePlan(plan, expected)
    const planSha256 = sha256(planPath, deps.readFile)
    const attemptId = deps.randomUUID()
    const planObjectName =
      `${PLAN_OBJECT_PREFIX}/${config.environment}/${attemptId}.tfplan`
    const attempt = {
      attemptId,
      environment: config.environment,
      cellId: config.cell.cellId,
      cellIncarnation: config.cellIncarnation,
      migName: config.cell.migName,
      instanceGroup: config.cell.instanceGroup,
      generationIdentity: config.cell.generationIdentity,
      fenceCommit: config.fenceCommit,
      planSha256,
      planObjectName,
      varFileSha256,
      terraformStateLineage: stateBinding.lineage,
      terraformStateSerial: stateBinding.serial,
      terraformStateObjectGeneration: stateBinding.generation,
      terraformStateObjectSha256: stateBinding.sha256,
      requestReason: `orca-relay-fence/${attemptId}`
    }
    const prepared = await deps.prepareAttempt(attempt)
    let durableAttempt = prepared?.attempt ?? prepared
    if (
      !durableAttempt ||
      !Number.isSafeInteger(durableAttempt.createdAt) ||
      !Number.isSafeInteger(durableAttempt.expiresAt)
    ) {
      throw new Error('durable fence attempt has no creation or expiry time')
    }
    assertAttemptMatches(config, durableAttempt, false)
    const uploaded = await deps.uploadPlan(planPath, durableAttempt)
    const bound = await deps.bindPlan({
      ...durableAttempt,
      planObjectGeneration: uploaded.generation
    })
    durableAttempt = bound?.attempt ?? bound
    assertAttemptMatches(config, durableAttempt)
    assertAttemptCheckoutBinding(config, durableAttempt, deps)
    await deps.preApplyGuard()
    validateTerraformFencePlan(
      terraformJson(deps, [
        `-chdir=${config.terraformDir}`,
        'show',
        '-json',
        planPath
      ]),
      expected
    )
    if (sha256(planPath, deps.readFile) !== planSha256) {
      throw new Error('saved fence plan digest changed')
    }
    assertStateObjectBinding(
      await deps.stateObjectBinding(join(directory, 'pre-apply-state.tfstate')),
      durableAttempt
    )
    const invocationId = deps.randomUUID()
    const invocationRequestReason =
      `${durableAttempt.requestReason}/${invocationId}`
    const startedResult = await deps.markApplyStarted(durableAttempt, {
      invocationId,
      requestReason: invocationRequestReason
    })
    const startedAttempt = {
      ...startedResult.attempt,
      applyInvocations: [
        ...(durableAttempt.applyInvocations ?? []),
        startedResult.invocation
      ]
    }
    if (!Number.isSafeInteger(startedAttempt?.applyStartedAt)) {
      throw new Error('durable fence attempt has no apply-start time')
    }
    let applyError
    try {
      deps.terraform(
        [
          `-chdir=${config.terraformDir}`,
          'apply',
          '-input=false',
          `-lock-timeout=${config.lockTimeout}`,
          planPath
        ],
        {
          env: {
            ...process.env,
            GOOGLE_REQUEST_REASON: invocationRequestReason
          }
        }
      )
    } catch (error) {
      applyError = error
    }
    const progress = await deps.inspectProgress(expected, startedAttempt)
    const classification = classifyTerraformFenceProgress(progress)
    const observedAttempt = await persistInvocationOperations(
      startedAttempt,
      progress,
      deps.markOperation
    )
    if (classification !== 'complete') {
      const reason = applyError ? 'apply response failed' : 'apply did not converge'
      throw new Error(`${reason}; recover-forward required`)
    }
    if (!progress.gceOperation) throw new Error('completed fence has no GCE operation evidence')
    if (completedStateBranch(progress, startedAttempt) !== 'complete') {
      throw new Error('Terraform state did not persist the completed fence')
    }
    await deps.assertZeroDiff()
    await deps.postApplyGuard(startedAttempt.cellIncarnation)
    const completedAttempt = {
      ...observedAttempt,
      gceOperation: progress.gceOperation
    }
    await deps.attest(completedAttempt)
    await deps.deletePlan(completedAttempt)
    deps.emit({
      event: 'terraform_cell_fenced',
      cellId: config.cell.cellId,
      attemptId: startedAttempt.attemptId,
      planSha256
    })
    return durableAttempt
  } finally {
    deps.remove(directory, { recursive: true, force: true })
  }
}

export async function inspectTerraformFenceProgress(config, deps, attempt) {
  const terraform = deps.terraform ?? defaultTerraform
  const expected = exactMigExpected(config.cell)
  const stateIdentity = terraformFenceStateIdentity(config, { terraform })
  const state = terraformJson({ terraform }, [
    `-chdir=${config.terraformDir}`,
    'show',
    '-json'
  ])
  const stateTargetSize = terraformFenceState(state, expected)
  const live = deps.gcloudJson([
    'compute',
    'instance-groups',
    'managed',
    'describe',
    config.cell.migName,
    '--project',
    config.project,
    '--zone',
    config.cell.zone,
    '--format=json'
  ])
  const instances = deps.gcloudJson([
    'compute',
    'instance-groups',
    'managed',
    'list-instances',
    config.cell.migName,
    '--project',
    config.project,
    '--zone',
    config.cell.zone,
    '--format=json'
  ])
  const operations = deps.gcloudJson([
    'compute',
    'operations',
    'list',
    '--project',
    config.project,
    `--filter=zone:(${config.cell.zone}) AND targetLink:${config.cell.migName}`,
    '--sort-by=~insertTime',
    '--limit=20',
    '--format=json'
  ])
  const operationCandidates = operations.filter((operation) => {
    const insertedAt = Date.parse(operation.insertTime)
    return (
      typeof operation.name === 'string' &&
      operation.targetLink ===
        `https://www.googleapis.com/compute/v1/projects/${config.project}/zones/${config.cell.zone}/instanceGroupManagers/${config.cell.migName}` &&
      operation.operationType === 'compute.instanceGroupManagers.resize' &&
      Number.isSafeInteger(attempt?.applyStartedAt) &&
      Number.isFinite(insertedAt) &&
      insertedAt >= attempt.applyStartedAt
    )
  })
  const invocations = attempt?.applyInvocations ?? []
  if (attempt?.applyStartedAt && invocations.length === 0) {
    throw new Error('Terraform fence apply has no durable invocation ledger')
  }
  const auditEntries = invocations.length > 0
    ? deps.gcloudJson([
        'logging',
        'read',
        `protoPayload.requestMetadata.requestAttributes.reason:"${attempt.requestReason}/" AND protoPayload.resourceName="projects/${config.project}/zones/${config.cell.zone}/instanceGroupManagers/${config.cell.migName}"`,
        '--project',
        config.project,
        '--limit=20',
        '--format=json'
      ])
    : []
  const invocationOperations = invocations.map((invocation) => {
    const matchingAudits = (Array.isArray(auditEntries) ? auditEntries : []).filter((entry) => {
      const payload = entry.protoPayload ?? {}
      return (
        payload.requestMetadata?.requestAttributes?.reason === invocation.requestReason &&
        payload.resourceName ===
          `projects/${config.project}/zones/${config.cell.zone}/instanceGroupManagers/${config.cell.migName}` &&
        String(payload.methodName ?? '').endsWith('instanceGroupManagers.resize') &&
        Number(payload.request?.size ?? payload.request?.targetSize) === 0
      )
    })
    if (matchingAudits.length > 1) {
      throw new Error('Terraform fence invocation has ambiguous audit operations')
    }
    const responseName = String(
      matchingAudits[0]?.protoPayload?.response?.name ?? ''
    )
    const operationName = responseName.includes('/operations/')
      ? responseName.slice(responseName.lastIndexOf('/') + 1)
      : responseName
    const expectedName = invocation.gceOperation ?? operationName
    const operation = expectedName
      ? operationCandidates.find((candidate) => candidate.name === expectedName)
      : undefined
    if (
      (invocation.gceOperation && operationName && invocation.gceOperation !== operationName) ||
      (expectedName && !operation)
    ) {
      throw new Error('Terraform fence invocation operation mismatch')
    }
    return {
      ...invocation,
      gceOperation: operation?.name,
      operationStatus: operation?.status ?? 'ABSENT',
      operationError: Boolean(operation?.error),
      auditBound: Boolean(matchingAudits.length === 1 && operation)
    }
  })
  const boundOperations = invocationOperations.filter(
    (invocation) => invocation.gceOperation
  )
  const finalOperation = boundOperations.at(-1)
  const operationStatus = invocationOperations.some((invocation) =>
    ['PENDING', 'RUNNING'].includes(invocation.operationStatus)
  )
    ? 'RUNNING'
    : (finalOperation?.operationStatus ?? 'ABSENT')
  return {
    stateTargetSize,
    stateLineage: stateIdentity.lineage,
    stateSerial: stateIdentity.serial,
    liveTargetSize: Number(live.targetSize),
    instanceCount: instances.length,
    operationStatus,
    operationError: invocationOperations.some(
      (invocation) => invocation.operationError
    ),
    operationAuditBound:
      boundOperations.length > 0 &&
      boundOperations.every((invocation) => invocation.auditBound),
    gceOperation: finalOperation?.gceOperation,
    invocationOperations
  }
}

function responseOperationName(entry) {
  const name = String(entry?.protoPayload?.response?.name ?? '')
  return name.includes('/operations/')
    ? name.slice(name.lastIndexOf('/') + 1)
    : name
}

export async function inspectCompletedTerraformFenceProgress(
  config,
  deps,
  attempt,
  recovery
) {
  if (!Number.isSafeInteger(attempt?.applyStartedAt)) {
    throw new Error('completed fence recovery has no durable apply start')
  }
  const terraform = deps.terraform ?? defaultTerraform
  const expected = exactMigExpected(config.cell)
  const stateIdentity = terraformFenceStateIdentity(config, { terraform })
  const state = terraformJson({ terraform }, [
    `-chdir=${config.terraformDir}`,
    'show',
    '-json'
  ])
  const stateTargetSize = terraformFenceState(state, expected)
  const live = deps.gcloudJson([
    'compute',
    'instance-groups',
    'managed',
    'describe',
    config.cell.migName,
    '--project',
    config.project,
    '--zone',
    config.cell.zone,
    '--format=json'
  ])
  const instances = deps.gcloudJson([
    'compute',
    'instance-groups',
    'managed',
    'list-instances',
    config.cell.migName,
    '--project',
    config.project,
    '--zone',
    config.cell.zone,
    '--format=json'
  ])
  const targetLink =
    `https://www.googleapis.com/compute/v1/projects/${config.project}/zones/${config.cell.zone}/instanceGroupManagers/${config.cell.migName}`
  const operations = deps.gcloudJson([
    'compute',
    'operations',
    'list',
    '--project',
    config.project,
    `--filter=zone:(${config.cell.zone}) AND targetLink:${config.cell.migName}`,
    '--sort-by=~insertTime',
    '--limit=20',
    '--format=json'
  ])
  const operationCandidates = operations.filter((operation) => {
    const insertedAt = Date.parse(operation.insertTime)
    return (
      typeof operation.name === 'string' &&
      operation.targetLink === targetLink &&
      operation.operationType === 'compute.instanceGroupManagers.resize' &&
      Number.isFinite(insertedAt) &&
      insertedAt >= attempt.applyStartedAt
    )
  })
  if (
    operationCandidates.length !== 1 ||
    operationCandidates[0].name !== recovery.gceOperation
  ) {
    throw new Error('completed fence recovery has no unique Compute operation')
  }
  const resourceName =
    `projects/${config.project}/zones/${config.cell.zone}/instanceGroupManagers/${config.cell.migName}`
  const auditEntries = deps.gcloudJson([
    'logging',
    'read',
    `protoPayload.authenticationInfo.principalEmail="${recovery.principalEmail}" AND protoPayload.resourceName="${resourceName}" AND protoPayload.methodName:"instanceGroupManagers.resize" AND timestamp>="${new Date(attempt.applyStartedAt).toISOString()}"`,
    '--project',
    config.project,
    '--limit=20',
    '--format=json'
  ])
  const matchingAudits = (Array.isArray(auditEntries) ? auditEntries : []).filter(
    (entry) => {
      const payload = entry.protoPayload ?? {}
      const timestamp = Date.parse(entry.timestamp)
      return (
        payload.authenticationInfo?.principalEmail === recovery.principalEmail &&
        payload.resourceName === resourceName &&
        String(payload.methodName ?? '').endsWith('instanceGroupManagers.resize') &&
        Number(payload.request?.size ?? payload.request?.targetSize) === 0 &&
        Number.isFinite(timestamp) &&
        timestamp >= attempt.applyStartedAt &&
        responseOperationName(entry) === recovery.gceOperation
      )
    }
  )
  if (matchingAudits.length !== 1) {
    throw new Error('completed fence recovery has no unique Audit Log operation')
  }
  const [operation] = operationCandidates
  return {
    stateTargetSize,
    stateLineage: stateIdentity.lineage,
    stateSerial: stateIdentity.serial,
    liveTargetSize: Number(live.targetSize),
    instanceCount: instances.length,
    liveStable: live.status?.isStable === true,
    operationStatus: operation.status,
    operationError: Boolean(operation.error),
    gceOperation: operation.name
  }
}

export function assertTerraformFenceSet(config, deps = {}) {
  const terraform = deps.terraform ?? defaultTerraform
  const result = terraform(
    [
      `-chdir=${config.terraformDir}`,
      'console',
      `-var-file=${config.varFile}`
    ],
    {
      encoding: 'utf8',
      input:
        `contains(var.relay_gce_fenced_cells, ${JSON.stringify(config.cell.cellId)}) && ` +
        `try(local.relay_gce_cell_target_sizes[${JSON.stringify(config.cell.cellId)}], -1) == 0\n`
    }
  )
  if (result.trim() !== 'true') {
    throw new Error('requested cell is not in the committed Terraform fence set')
  }
}

export async function recoverSupersededCompletedTerraformFence(
  config,
  deps,
  recovery
) {
  assertFenceIdentity(config.cell)
  const varFileSha256 = assertReviewedFenceCheckout(config, deps)
  await deps.assertCommittedFenceSet()
  const attempt = await deps.loadAttempt(config.cell.cellId)
  if (
    !attempt ||
    attempt.fenceCommit === config.fenceCommit ||
    attempt.attemptId !== recovery.attemptId ||
    attempt.fenceCommit !== recovery.fenceCommit ||
    attempt.terraformStateSerial !== recovery.terraformStateSerial ||
    attempt.planObjectGeneration !== recovery.planObjectGeneration
  ) {
    throw new Error('completed fence recovery does not match the pinned attempt')
  }
  assertAttemptMatches({ ...config, fenceCommit: attempt.fenceCommit }, attempt)
  if (
    varFileSha256 !== attempt.varFileSha256 ||
    !Number.isSafeInteger(attempt.applyStartedAt) ||
    attempt.abortedAt ||
    (attempt.gceOperation && attempt.gceOperation !== recovery.gceOperation)
  ) {
    throw new Error('completed fence recovery attempt is not adoptable')
  }
  const invocations = attempt.applyInvocations ?? []
  if (
    invocations.length !== 1 ||
    (invocations[0].gceOperation &&
      invocations[0].gceOperation !== recovery.gceOperation) ||
    invocations[0].startedAt < attempt.applyStartedAt
  ) {
    throw new Error('completed fence recovery invocation ledger is unsafe')
  }
  const resolved = await deps.resolvePlan(attempt)
  const planExists = resolved.generation === attempt.planObjectGeneration
  if (!planExists && !(attempt.completedAt && resolved.generation === null)) {
    throw new Error('completed fence recovery saved-plan generation changed')
  }
  const directory = privatePlanDirectory({
    mkdtemp: deps.mkdtemp ?? mkdtempSync,
    chmod: deps.chmod ?? chmodSync,
    tmpdir: deps.tmpdir ?? tmpdir
  })
  try {
    const stateBinding = await deps.stateObjectBinding(
      join(directory, 'completed-state.tfstate')
    )
    if (
      stateBinding.generation !== recovery.terraformStateObjectGeneration ||
      stateBinding.sha256 !== recovery.terraformStateObjectSha256 ||
      stateBinding.lineage !== attempt.terraformStateLineage ||
      stateBinding.serial !== attempt.terraformStateSerial + 1
    ) {
      throw new Error('completed fence recovery state object changed')
    }
    if (planExists) {
      const planPath = join(directory, 'fence.tfplan')
      await deps.downloadPlan(attempt, planPath)
      if ((deps.stat ?? statSync)(planPath).mode & 0o077) {
        throw new Error('downloaded saved fence plan permissions are not private')
      }
      if (sha256(planPath, deps.readFile ?? readFileSync) !== attempt.planSha256) {
        throw new Error('completed fence recovery saved-plan digest changed')
      }
      validateTerraformFencePlan(
        terraformJson(
          { terraform: deps.terraform ?? defaultTerraform },
          [`-chdir=${config.terraformDir}`, 'show', '-json', planPath]
        ),
        exactMigExpected(config.cell)
      )
    }
    const progress = await deps.inspectCompletedProgress(
      exactMigExpected(config.cell),
      attempt,
      recovery
    )
    if (
      progress.stateLineage !== attempt.terraformStateLineage ||
      progress.stateSerial !== attempt.terraformStateSerial + 1 ||
      progress.stateTargetSize !== 0 ||
      progress.liveTargetSize !== 0 ||
      progress.instanceCount !== 0 ||
      progress.liveStable !== true ||
      progress.operationStatus !== 'DONE' ||
      progress.operationError ||
      progress.gceOperation !== recovery.gceOperation
    ) {
      throw new Error('completed fence recovery production evidence is unsafe')
    }
    const invocation = {
      ...invocations[0],
      gceOperation: recovery.gceOperation
    }
    const marked = attempt.gceOperation
      ? { attempt, invocation }
      : await deps.markOperation(
          { ...attempt, gceOperation: recovery.gceOperation },
          invocation
        )
    await deps.assertZeroDiff()
    await deps.postApplyGuard(attempt.cellIncarnation)
    await deps.attest({
      ...marked.attempt,
      applyInvocations: [marked.invocation],
      gceOperation: recovery.gceOperation
    })
    if (planExists) await deps.deletePlan(attempt)
    deps.emit?.({
      event: 'terraform_cell_fence_completed_attempt_recovered',
      cellId: config.cell.cellId,
      attemptId: attempt.attemptId,
      gceOperation: recovery.gceOperation
    })
  } finally {
    ;(deps.remove ?? rmSync)(directory, { recursive: true, force: true })
  }
}

export async function resumeTerraformFence(config, deps) {
  assertFenceIdentity(config.cell)
  assertReviewedFenceCheckout(config, deps)
  await deps.assertCommittedFenceSet()
  let attempt = await deps.loadAttempt(config.cell.cellId)
  assertAttemptMatches(config, attempt, false)
  if (!attempt.planObjectGeneration) {
    const resolved = await deps.resolvePlan(attempt)
    if (!resolved.generation) throw new Error('durable fence plan object is missing')
    const bound = await deps.bindPlan({
      ...attempt,
      planObjectGeneration: resolved.generation
    })
    attempt = bound?.attempt ?? bound
  }
  assertAttemptMatches(config, attempt)
  assertAttemptCheckoutBinding(config, attempt, deps)
  let progress = await deps.inspectProgress(exactMigExpected(config.cell), attempt)
  let classification = classifyTerraformFenceProgress(progress)
  if (classification === 'complete') {
    if (completedStateBranch(progress, attempt) === 'replay') {
      classification = 'reconcile-state'
    } else {
      await deps.assertZeroDiff()
    }
  }
  if (classification !== 'complete') {
    if (classification === 'in-progress' && Number.isSafeInteger(attempt.applyStartedAt)) {
      throw new Error('Terraform fence operation is still running; recover-forward required')
    }
    attempt = await persistInvocationOperations(
      attempt,
      progress,
      deps.markOperation
    )
    assertReplayStateIdentity(progress, attempt)
    await deps.preApplyGuard()
    const directory = privatePlanDirectory({
      mkdtemp: deps.mkdtemp ?? mkdtempSync,
      chmod: deps.chmod ?? chmodSync,
      tmpdir: deps.tmpdir ?? tmpdir
    })
    const planPath = join(directory, 'fence.tfplan')
    try {
      assertStateObjectBinding(
        await deps.stateObjectBinding(
          join(directory, 'replay-pre-state.tfstate')
        ),
        attempt
      )
      await deps.downloadPlan(attempt, planPath)
      const stat = (deps.stat ?? statSync)(planPath)
      if ((stat.mode & 0o077) !== 0) {
        throw new Error('downloaded saved fence plan permissions are not private')
      }
      if (sha256(planPath, deps.readFile ?? readFileSync) !== attempt.planSha256) {
        throw new Error('downloaded saved fence plan digest mismatch')
      }
      validateTerraformFencePlan(
        terraformJson(
          { terraform: deps.terraform ?? defaultTerraform },
          [`-chdir=${config.terraformDir}`, 'show', '-json', planPath]
        ),
        exactMigExpected(config.cell)
      )
      const invocationId = (deps.randomUUID ?? randomUUID)()
      const invocationRequestReason = `${attempt.requestReason}/${invocationId}`
      const started = await deps.markApplyStarted(attempt, {
        invocationId,
        requestReason: invocationRequestReason
      })
      attempt = {
        ...started.attempt,
        applyInvocations: [
          ...(attempt.applyInvocations ?? []),
          started.invocation
        ]
      }
      let applyError
      try {
        ;(deps.terraform ?? defaultTerraform)(
          [
            `-chdir=${config.terraformDir}`,
            'apply',
            '-input=false',
            `-lock-timeout=${config.lockTimeout}`,
            planPath
          ],
          {
            env: {
              ...process.env,
              GOOGLE_REQUEST_REASON: invocationRequestReason
            }
          }
        )
      } catch (error) {
        applyError = error
      }
      progress = await deps.inspectProgress(exactMigExpected(config.cell), attempt)
      classification = classifyTerraformFenceProgress(progress)
      attempt = await persistInvocationOperations(
        attempt,
        progress,
        deps.markOperation
      )
      if (classification !== 'complete') {
        const reason = applyError ? 'saved-plan replay response failed' : 'saved-plan replay did not converge'
        throw new Error(`${reason}; recover-forward required`)
      }
      if (completedStateBranch(progress, attempt) !== 'complete') {
        throw new Error('Terraform state did not persist the replayed fence')
      }
      await deps.assertZeroDiff()
    } finally {
      ;(deps.remove ?? rmSync)(directory, { recursive: true, force: true })
    }
  }
  const gceOperation = progress.gceOperation ?? attempt.gceOperation
  if (!gceOperation) throw new Error('completed fence has no GCE operation evidence')
  await deps.postApplyGuard(attempt.cellIncarnation)
  await deps.attest({ ...attempt, gceOperation })
  await deps.deletePlan(attempt)
  deps.emit?.({
    event: 'terraform_cell_fence_resumed',
    cellId: config.cell.cellId,
    attemptId: attempt.attemptId
  })
}

export async function abortTerraformFenceBeforeApply(config, deps) {
  assertFenceIdentity(config.cell)
  assertReviewedFenceCheckout(config, deps)
  await deps.assertCommittedFenceSet()
  let attempt = await deps.loadAttempt(config.cell.cellId)
  assertAttemptMatches(config, attempt, false)
  if (!attempt.planObjectGeneration) {
    const resolved = await deps.resolvePlan(attempt)
    if (resolved.generation) {
      const bound = await deps.bindPlan({
        ...attempt,
        planObjectGeneration: resolved.generation
      })
      attempt = bound?.attempt ?? bound
    }
  }
  assertAttemptMatches(config, attempt, Boolean(attempt.planObjectGeneration))
  assertAttemptCheckoutBinding(config, attempt, deps)
  const progress = await deps.inspectProgress(exactMigExpected(config.cell), attempt)
  if (classifyTerraformFenceProgress(progress) !== 'not-started') {
    throw new Error('cannot abort after Terraform fence apply may have started')
  }
  if (attempt.applyStartedAt) throw new Error('cannot abort after Terraform fence apply was marked')
  await deps.abortAttempt(attempt)
  if (attempt.planObjectGeneration) await deps.deletePlan(attempt)
  deps.emit?.({ event: 'terraform_fence_aborted_before_apply', cellId: config.cell.cellId })
}

export async function abortSupersededTerraformFenceBeforeUpload(config, deps) {
  assertFenceIdentity(config.cell)
  const varFileSha256 = assertReviewedFenceCheckout(config, deps)
  await deps.assertCommittedFenceSet()
  const attempt = await deps.loadAttempt(config.cell.cellId)
  if (
    !attempt ||
    !/^[a-f0-9]{40}$/.test(attempt.fenceCommit ?? '') ||
    attempt.fenceCommit === config.fenceCommit
  ) {
    throw new Error('prepared Terraform fence attempt is not from a superseded commit')
  }
  assertAttemptMatches({ ...config, fenceCommit: attempt.fenceCommit }, attempt, false)
  if (attempt.varFileSha256 !== varFileSha256) {
    throw new Error('superseded Terraform fence variable-file digest changed')
  }
  if (
    attempt.planObjectGeneration ||
    attempt.applyStartedAt ||
    attempt.completedAt ||
    attempt.gceOperation ||
    (attempt.applyInvocations?.length ?? 0) > 0
  ) {
    throw new Error('cannot supersede a Terraform fence attempt after plan upload')
  }
  const resolved = await deps.resolvePlan(attempt)
  if (resolved?.generation !== null) {
    throw new Error('cannot supersede a Terraform fence attempt with a saved plan')
  }
  const progress = await deps.inspectProgress(exactMigExpected(config.cell), attempt)
  if (classifyTerraformFenceProgress(progress) !== 'not-started') {
    throw new Error('cannot supersede after Terraform fence apply may have started')
  }
  await deps.abortAttempt(attempt)
  deps.emit?.({
    event: 'terraform_fence_superseded_before_upload',
    cellId: config.cell.cellId,
    previousFenceCommit: attempt.fenceCommit,
    fenceCommit: config.fenceCommit
  })
}
