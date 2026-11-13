import { findCommunityCandidateRun } from './community-candidate-run'
import { stageCommunityCandidateRun } from './community-candidate-artifact'
import { createCommunityReviewBranch } from './community-review-branch'
import {
  communityCandidatePlanSchema as planSchema,
  communityCandidateRunSchema as runSchema
} from './community-candidate-record'
import { fetchCommunityCandidateJson } from './community-candidate-github'
import { getCustomBuildInfo } from '../../shared/custom-build'
import type { CommunityPullRequest } from '../../shared/community-catalog'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  CommunityArtifactReceipt,
  CommunityCandidatePlan,
  CommunityCandidateRun,
  CommunityCandidateHistoryPage
} from '../../shared/community-candidates'
import type { CommunityHostService } from './community-host-service'
import { writeCommunityJson } from './community-json-file'
import { COMMUNITY_CANDIDATE_WORKFLOW_SHA256 } from './community-candidate-workflow-digest'
const sha = z.string().regex(/^[a-f0-9]{40}$/)
export class CommunityCandidateService {
  private dispatches = new Map<string, Promise<CommunityCandidateRun>>()
  private downloads = new Map<string, Promise<CommunityArtifactReceipt>>()
  private indexWrites: Promise<void> = Promise.resolve()
  constructor(
    private readonly root: string,
    private readonly community: CommunityHostService,
    private readonly user: () => Promise<string | null>
  ) {}
  async prepare(): Promise<CommunityCandidatePlan> {
    const build = getCustomBuildInfo()
    if (build && !build.source) {
      throw new Error(
        'This Custom build has unrecorded local patches. A source manifest is required to preserve its changes in the next candidate.'
      )
    }
    const selected = Object.values((await this.community.features.read()).features).filter(
      (row) => row.selectedAt
    )
    if ((!selected.length && !build?.source) || selected.length > 12) {
      throw new Error('Select between 1 and 12 additions before preparing a candidate.')
    }
    const rows: CommunityPullRequest[] = []
    for (const feature of selected) {
      rows.push(await this.community.observeSource(feature.number))
    }
    const additions = rows.filter(
      (row) =>
        !build?.changes.some(
          (change) =>
            change.pullRequest?.number === row.number && change.pullRequest.headSha === row.headSha
        )
    )
    if (!additions.length && !build?.source) {
      throw new Error('No new source versions were selected.')
    }
    if (additions.some((row) => row.state !== 'open')) {
      throw new Error(
        'A selected PR is no longer open. Review its official status before preparing a candidate.'
      )
    }
    const base = z.object({ sha }).parse(await this.api('repos/stablyai/orca/commits/main'))
    const content = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      baseSha: base.sha,
      profileMode: build?.profileMode ?? null,
      customSource: build?.source ?? null,
      includedChanges: (build?.changes ?? []).filter(
        (change) => !additions.some((pr) => pr.number === change.pullRequest?.number)
      ),
      additions: additions.map((row) => ({
        number: row.number,
        title: row.title,
        headSha: row.headSha,
        sourceUrl: row.url
      }))
    }
    const plan = {
      ...content,
      digest: createHash('sha256').update(JSON.stringify(content)).digest('hex')
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const checkedPlan = planSchema.parse(plan)
    await writeCommunityJson(join(this.root, `${plan.id}.json`), checkedPlan, true)
    const write = this.indexWrites.then(async () => {
      const index = await this.index()
      await writeCommunityJson(join(this.root, 'index.json'), [plan.id, ...index], true)
    })
    this.indexWrites = write.catch(() => {})
    await write
    for (const addition of plan.additions) {
      await this.community.features.recordCandidate(addition.number, {
        id: plan.id,
        state: 'source-plan-prepared',
        url: null,
        headSha: addition.headSha
      })
    }
    return plan
  }
  private async index(): Promise<string[]> {
    try {
      return z
        .array(z.uuid())
        .max(10_000)
        .parse(JSON.parse(await readFile(join(this.root, 'index.json'), 'utf8')))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    }
  }
  async history(offset = 0): Promise<CommunityCandidateHistoryPage> {
    await this.indexWrites
    const ids = await this.index()
    const rows: CommunityCandidateHistoryPage['rows'] = []
    for (const id of ids.slice(offset, offset + 20)) {
      const plan = await this.plan(id)
      let run: CommunityCandidateRun | null = null
      try {
        run = runSchema.parse(JSON.parse(await readFile(join(this.root, `${id}-run.json`), 'utf8')))
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
      rows.push({ plan, run })
    }
    return { rows, nextOffset: offset + 20 < ids.length ? offset + 20 : null }
  }

  private api(path: string, init?: RequestInit): Promise<unknown> {
    return fetchCommunityCandidateJson(this.user, path, init)
  }
  private async plan(id: string): Promise<CommunityCandidatePlan> {
    return planSchema.parse(JSON.parse(await readFile(join(this.root, `${id}.json`), 'utf8')))
  }
  dispatch(id: string, repository: string, ref: string): Promise<CommunityCandidateRun> {
    const pending = this.dispatches.get(id)
    if (pending) {
      return pending
    }
    const dispatch = this.performDispatch(id, repository, ref).finally(() =>
      this.dispatches.delete(id)
    )
    this.dispatches.set(id, dispatch)
    return dispatch
  }
  private async performDispatch(
    id: string,
    repository: string,
    ref: string
  ): Promise<CommunityCandidateRun> {
    const user = await this.user()
    if (!user || repository.toLowerCase() !== `${user}/orca`.toLowerCase()) {
      throw new Error('Candidate builds must run in your own Orca fork.')
    }
    const plan = await this.plan(id)
    for (const addition of plan.additions) {
      const current = await this.community.observeSource(addition.number)
      if (current.headSha !== addition.headSha || current.state !== 'open') {
        throw new Error('A selected PR changed. Prepare a new plan.')
      }
    }
    const snapshot = z
      .object({ sha })
      .parse(await this.api(`repos/${repository}/commits/${encodeURIComponent(ref)}`))
    const workflow = z
      .object({ encoding: z.literal('base64'), content: z.string() })
      .parse(
        await this.api(
          `repos/${repository}/contents/.github/workflows/community-candidate.yml?ref=${snapshot.sha}`
        )
      )
    const digest = createHash('sha256')
      .update(Buffer.from(workflow.content, 'base64'))
      .digest('hex')
    if (digest !== COMMUNITY_CANDIDATE_WORKFLOW_SHA256) {
      throw new Error(
        'This fork does not have the expected isolated candidate workflow. Sync the Community feature branch first.'
      )
    }
    try {
      await this.api(`repos/${repository}/actions/workflows/community-candidate.yml`)
    } catch {
      throw new Error(
        'Install the Community candidate workflow on your fork’s default branch before starting a run. This is a one-time setup; the selected workflow version is still pinned and checked separately.'
      )
    }
    const run: CommunityCandidateRun = {
      plan,
      repository,
      workflowRef: `orca-community/${id}`,
      workflowCommit: snapshot.sha,
      source: null,
      artifact: null,
      requestedAt: new Date().toISOString(),
      runId: null,
      url: null,
      state: 'dispatch-requested',
      conclusion: null,
      artifactUrl: null
    }
    const path = join(this.root, `${id}-run.json`)
    try {
      return runSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    await writeCommunityJson(path, run, true)
    try {
      run.source = await createCommunityReviewBranch(
        (path, init) => this.api(path, init),
        repository,
        plan
      )
      await writeCommunityJson(path, run, true)
      await this.api(`repos/${repository}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/tags/${run.workflowRef}`, sha: snapshot.sha })
      })
      await this.api(`repos/${repository}/actions/workflows/community-candidate.yml/dispatches`, {
        method: 'POST',
        body: JSON.stringify({
          ref: run.workflowRef,
          inputs: { plan_id: id, plan: JSON.stringify({ ...plan, combinedSource: run.source }) }
        })
      })
    } catch (error) {
      await writeCommunityJson(path, { ...run, state: 'dispatch-unconfirmed' }, true)
      throw error
    }
    for (const addition of plan.additions) {
      await this.community.features.recordCandidate(addition.number, {
        id,
        state: run.state,
        url: null,
        headSha: addition.headSha
      })
    }
    return run
  }
  stageArtifact(id: string): Promise<CommunityArtifactReceipt> {
    const pending = this.downloads.get(id)
    if (pending) {
      return pending
    }
    const download = this.downloadArtifact(id).finally(() => this.downloads.delete(id))
    this.downloads.set(id, download)
    return download
  }
  private async downloadArtifact(id: string): Promise<CommunityArtifactReceipt> {
    return stageCommunityCandidateRun(
      this.root,
      id,
      await this.user(),
      (path) => this.api(path),
      this.community.features
    )
  }
  async status(id: string): Promise<CommunityCandidateRun> {
    const path = join(this.root, `${id}-run.json`)
    const saved = runSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    const found = await findCommunityCandidateRun(saved, (path) => this.api(path))
    if (!found) {
      return saved
    }
    const current = runSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    const run = {
      ...current,
      runId: found.id,
      url: found.html_url,
      state: found.status,
      conclusion: found.conclusion,
      artifactUrl: found.status === 'completed' ? found.html_url : null
    }
    await writeCommunityJson(path, run, true)
    for (const addition of saved.plan.additions) {
      await this.community.features.recordCandidate(addition.number, {
        id,
        state: run.conclusion ?? run.state,
        url: run.url,
        headSha: addition.headSha
      })
    }
    return run
  }
}
