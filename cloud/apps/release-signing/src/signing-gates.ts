import { z } from 'zod'
import {
  artifactConfigurations,
  type SigningConfig,
  type SigningPolicy,
  type SigningStage
} from './config.js'
import { ApiError, type SigningApis } from './github-app.js'

const runSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  path: z.string(),
  event: z.literal('workflow_dispatch'),
  head_branch: z.string(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  repository: z.object({ full_name: z.string() }),
  head_repository: z.object({ full_name: z.string() })
})
const pendingSchema = z.array(z.object({ environment: z.object({ name: z.string() }) }))
const artifactSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  expired: z.boolean(),
  workflow_run: z.object({ id: z.number(), head_sha: z.string() })
})
const requestSchema = z.object({
  status: z.string(),
  isFinalStatus: z.boolean(),
  projectSlug: z.string(),
  signingPolicySlug: z.string(),
  artifactConfigurationSlug: z.string(),
  origin: z.object({
    buildData: z.object({ url: z.string().url() }),
    repositoryData: z.object({ url: z.string().url(), commitId: z.string() })
  })
})

export function originRunId(value: string, repository: string): number {
  const url = new URL(value)
  const prefix = `/${repository}/actions/runs/`
  if (
    url.origin !== 'https://github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix)
  )
    throw new Error('Untrusted signing origin')
  const match = /^(\d+)(?:\/job\/\d+)?\/?$/.exec(url.pathname.slice(prefix.length))
  const id = Number(match?.[1])
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid signing origin run')
  return id
}

export class SigningGates {
  private readonly root: string
  private configurationCheck: Promise<void> | undefined
  private configurationCheckedAt = 0
  constructor(
    private readonly config: SigningConfig,
    private readonly apis: SigningApis
  ) {
    this.root = `/repos/${config.repository}`
  }
  async checkConfiguration(): Promise<void> {
    if (!this.configurationCheck || Date.now() - this.configurationCheckedAt >= 30_000) {
      this.configurationCheckedAt = Number.POSITIVE_INFINITY
      this.configurationCheck = this.verifyConfiguration().finally(() => {
        this.configurationCheckedAt = Date.now()
      })
    }
    await this.configurationCheck
  }
  private async verifyConfiguration(): Promise<void> {
    for (const policy of this.config.policies) {
      for (const environment of Object.values(policy.environments)) {
        const path = `${this.root}/environments/${encodeURIComponent(environment)}`
        const env = z
          .object({ can_admins_bypass: z.literal(false) })
          .parse(await this.apis.github(path))
        const rules = z
          .object({
            custom_deployment_protection_rules: z.array(
              z.object({
                enabled: z.boolean(),
                app: z.object({ id: z.number() })
              })
            )
          })
          .parse(await this.apis.github(`${path}/deployment_protection_rules`))
        if (
          !rules.custom_deployment_protection_rules.some(
            (rule) => rule.enabled && String(rule.app.id) === this.config.appId
          ) ||
          env.can_admins_bypass
        )
          throw new Error(`Signing protection is missing: ${environment}`)
      }
    }
  }
  async processRun(runId: number, requestedEnvironment?: string): Promise<void> {
    const run = runSchema.parse(await this.apis.github(`${this.root}/actions/runs/${runId}`))
    if (
      run.id !== runId ||
      run.repository.full_name !== this.config.repository ||
      run.head_repository.full_name !== this.config.repository
    )
      throw new Error('Untrusted repository')
    const policy = this.config.policies.find(
      (p) => p.workflow === run.path && p.branch === run.head_branch
    )
    if (!policy) throw new Error('Untrusted release workflow or branch')
    const pending = pendingSchema.parse(
      await this.apis.github(`${this.root}/actions/runs/${runId}/pending_deployments`)
    )
    for (const stage of ['inner', 'installer'] as const) {
      const environment = policy.environments[stage]
      if (requestedEnvironment && requestedEnvironment !== environment) continue
      if (!pending.some((p) => p.environment.name === environment)) continue
      await this.processStage(run, policy, stage)
    }
  }
  private async processStage(
    run: z.infer<typeof runSchema>,
    policy: SigningPolicy,
    stage: SigningStage
  ): Promise<void> {
    const artifacts = z
      .object({ artifacts: z.array(artifactSchema), total_count: z.number() })
      .parse(await this.apis.github(`${this.root}/actions/runs/${run.id}/artifacts?per_page=100`))
    if (artifacts.total_count > 100)
      throw new Error('Signing artifact inventory exceeds supported bound')
    const prefix = `orca-signing-${stage}-${run.id}-1-`
    const matching = artifacts.artifacts.filter((a) => a.name.startsWith(prefix))
    if (matching.length !== 1)
      throw new Error('Exactly one immutable signing checkpoint is required')
    const artifact = matching[0]!
    if (
      artifact.expired ||
      artifact.workflow_run.id !== run.id ||
      artifact.workflow_run.head_sha !== run.head_sha
    )
      throw new Error('Signing checkpoint origin mismatch or expiration')
    const requestId = z.string().uuid().parse(artifact.name.slice(prefix.length))
    const request = requestSchema.parse(await this.apis.signpath(requestId))
    const repo = new URL(request.origin.repositoryData.url)
    if (
      originRunId(request.origin.buildData.url, this.config.repository) !== run.id ||
      repo.origin !== 'https://github.com' ||
      repo.pathname.replace(/\/$/, '').replace(/\.git$/, '') !== `/${this.config.repository}` ||
      repo.username ||
      repo.password ||
      repo.search ||
      repo.hash ||
      request.origin.repositoryData.commitId !== run.head_sha ||
      request.projectSlug !== this.config.signpathProject ||
      request.signingPolicySlug !== policy.signingPolicy ||
      request.artifactConfigurationSlug !== artifactConfigurations[stage]
    )
      throw new Error('SignPath provenance or policy mismatch')
    const approved = request.status === 'Completed' && request.isFinalStatus
    const rejected =
      ['Failed', 'Denied', 'Canceled'].includes(request.status) && request.isFinalStatus
    if (!approved && !rejected) return
    const current = runSchema.parse(await this.apis.github(`${this.root}/actions/runs/${run.id}`))
    if (current.run_attempt !== run.run_attempt || current.head_sha !== run.head_sha)
      throw new Error('Release attempt changed during validation')
    const environment = policy.environments[stage]
    try {
      await this.apis.github(`${this.root}/actions/runs/${run.id}/deployment_protection_rule`, {
        environment_name: environment,
        state: approved ? 'approved' : 'rejected',
        comment: `SignPath ${stage} request ${requestId}: ${request.status}. Provenance checked for run ${run.id}.`
      })
    } catch (error) {
      if (!(error instanceof ApiError) || ![409, 422].includes(error.status)) throw error
      const remaining = pendingSchema.parse(
        await this.apis.github(`${this.root}/actions/runs/${run.id}/pending_deployments`)
      )
      if (remaining.some((p) => p.environment.name === environment)) throw error
    }
  }
  async processSignpath(requestId: string): Promise<void> {
    const request = requestSchema.parse(await this.apis.signpath(requestId))
    // The callback is a wake-up signal; the checkpoint and a fresh API read authorize the gate.
    await this.processRun(originRunId(request.origin.buildData.url, this.config.repository))
  }
  async reconcile(): Promise<void> {
    const failures: unknown[] = []
    for (const policy of this.config.policies) {
      try {
        const workflow = encodeURIComponent(policy.workflow.split('/').at(-1)!)
        const runs = z
          .object({
            total_count: z.number(),
            workflow_runs: z.array(z.object({ id: z.number().int().positive() }))
          })
          .parse(
            await this.apis.github(
              `${this.root}/actions/workflows/${workflow}/runs?status=waiting&branch=${encodeURIComponent(policy.branch)}&per_page=100`
            )
          )
        if (runs.total_count > 100) throw new Error('Too many waiting release runs')
        for (const run of runs.workflow_runs) {
          try {
            await this.processRun(run.id)
          } catch (error) {
            failures.push(error)
          }
        }
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, `${failures.length} signing reconciliation checks failed`)
  }
}
