import { communityEvidenceSignals } from './community-evidence-signals'
import type { CommunityPullRequest } from '../../shared/community-catalog'
import { getCustomBuildInfo } from '../../shared/custom-build'
import { CommunityEvidenceStore } from './community-evidence-store'
import { verifyCommunityRelease } from './community-release-proof'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { getMainHttpClient } from '../network/http-client'
import { getAppEnvironment } from '../../shared/app-environment'
import { listGhAccountBindingInventory } from '../github/accounts/gh-account-binding-inventory'
import { resolveGhAccountToken } from '../github/accounts/gh-account-token'
import type { CommunityFeatureAction } from '../../shared/community-features'
import type { CommunityQuery, CommunityDetail } from '../../shared/community-operations'
import { CommunityCatalogStore } from './community-catalog-store'
import { CommunityGitHubSource } from './community-github-source'
import { CommunityService } from './community-service'
import { CommunityFeatureStore } from './community-feature-store'
import { queryCommunityCatalog } from './community-catalog-query'
import { communityGitHubDetail } from './community-github-detail'
import { CommunityPublishedData } from './community-published-data'
import { CommunityCandidateService } from './community-candidate-service'
import { writeCommunityJson } from './community-json-file'

const settingsSchema = z.object({ version: z.literal(1), user: z.string().nullable() })
export class CommunityHostService {
  readonly evidence: CommunityEvidenceStore
  readonly candidates: CommunityCandidateService
  readonly features: CommunityFeatureStore
  readonly catalog: CommunityService
  readonly published: CommunityPublishedData
  private readonly source: CommunityGitHubSource
  private initialized: Promise<void> | null = null
  private user: string | null = null
  private detailReads = new Map<number, { at: number; value: Promise<CommunityDetail> }>()
  constructor(private readonly root: string) {
    this.evidence = new CommunityEvidenceStore(join(root, 'evidence'))
    this.candidates = new CommunityCandidateService(join(root, 'candidates'), this, async () => {
      await this.initialize()
      return this.user
    })
    this.features = new CommunityFeatureStore(root)
    this.source = new CommunityGitHubSource(
      (input, init) => getMainHttpClient().fetch(String(input), init),
      async () => {
        await this.initialize()
        return this.user ? resolveGhAccountToken({ host: 'github.com', user: this.user }) : null
      }
    )
    this.catalog = new CommunityService(new CommunityCatalogStore(root), this.source, () => {})
    this.published = new CommunityPublishedData(root, this.source)
  }
  private initialize(): Promise<void> {
    return (this.initialized ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const build = getCustomBuildInfo()
      for (const change of build?.changes ?? []) {
        if (build && change.pullRequest) {
          await this.features.recordRunningBuild(change.pullRequest.number, {
            buildId: build.id,
            baseVersion: build.baseVersion,
            title: change.title,
            headSha: change.pullRequest.headSha
          })
        }
      }
      try {
        this.user = settingsSchema.parse(
          JSON.parse(await readFile(join(this.root, 'account.json'), 'utf8'))
        ).user
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
    })())
  }
  async accounts() {
    await this.initialize()
    const inventory = await listGhAccountBindingInventory({}, { requiredHost: 'github.com' })
    return {
      selected: this.user,
      users: inventory.accounts
        .filter((account) => account.source === 'keyring')
        .map((account) => account.user)
    }
  }
  async account(user: string | null): Promise<void> {
    await this.initialize()
    if (user) {
      await resolveGhAccountToken({ host: 'github.com', user })
    }
    await writeCommunityJson(join(this.root, 'account.json'), { version: 1, user }, true)
    this.user = user
  }
  async list(query: CommunityQuery) {
    await this.initialize()
    const [{ catalog, status }, personal] = await Promise.all([
      this.catalog.read(),
      this.features.read()
    ])
    if (catalog && query.view && query.view !== 'explore') {
      const known = new Set(catalog.pullRequests.map((row) => row.number))
      const archived = Object.values(personal.features).filter(
        (row) =>
          !known.has(row.number) &&
          (query.view === 'saved'
            ? row.savedAt
            : query.view === 'viewed'
              ? row.visit
              : row.selectedAt)
      )
      const captured: CommunityPullRequest[] = []
      for (let i = 0; i < archived.length; i += 16) {
        const batch = await Promise.all(
          archived.slice(i, i + 16).map((row) => this.catalog.captured(row.number))
        )
        captured.push(...batch.filter((row) => row !== null))
      }
      return queryCommunityCatalog(
        { ...catalog, pullRequests: [...catalog.pullRequests, ...captured] },
        personal,
        status,
        query
      )
    }
    return queryCommunityCatalog(catalog, personal, status, query)
  }
  async mutate(action: CommunityFeatureAction) {
    if (action.action === 'select' || action.action === 'visit' || action.action === 'save') {
      const row =
        (await this.catalog.captured(action.number)) ?? (await this.catalog.detail(action.number))
      if (action.action === 'visit' && row.headSha !== action.headSha) {
        throw new Error('This PR has a new source version. Refresh before marking it viewed.')
      }
      await this.features.observe(row)
    }
    return this.features.mutate(action)
  }
  detail(number: number, force = false): Promise<CommunityDetail> {
    if (force) {
      this.detailReads.delete(number)
    }
    const existing = this.detailReads.get(number)
    if (existing && Date.now() - existing.at < 120_000) {
      return existing.value.then(async (value) => ({
        ...value,
        feature: (await this.features.read()).features[number] ?? null,
        history: await this.features.history(number)
      }))
    }
    const value = (async () => {
      const cached = await this.catalog.captured(number)
      let pr
      try {
        pr = await this.catalog.detail(number, force)
      } catch (error) {
        if (!cached) {
          throw error
        }
        pr = cached
      }
      const details = await communityGitHubDetail(
        this.source,
        number,
        pr.headSha,
        new AbortController().signal
      )
      await this.features.observe(pr)
      const evidenceId = await this.evidence.save({
        repository: 'stablyai/orca',
        number,
        headSha: pr.headSha,
        ...details
      })
      await this.features.recordEvidence(
        number,
        evidenceId,
        communityEvidenceSignals(pr.headSha, details, new Date().toISOString())
      )
      return {
        pr,
        ...details,
        observedAt: pr.observedAt ?? new Date().toISOString(),
        feature: (await this.features.read()).features[number] ?? null,
        sourceHistory: await this.catalog.history(number),
        history: await this.features.history(number)
      }
    })()
    if (this.detailReads.size >= 100) {
      const oldest = this.detailReads.keys().next().value
      if (oldest !== undefined) {
        this.detailReads.delete(oldest)
      }
    }
    this.detailReads.set(number, { at: Date.now(), value })
    void value.catch(() => {
      if (this.detailReads.get(number)?.value === value) {
        this.detailReads.delete(number)
      }
    })
    return value
  }
  async observeSource(number: number) {
    const pr = await this.catalog.detail(number, true)
    await this.features.observe(pr)
    return pr
  }
  verifyRelease(number: number) {
    return verifyCommunityRelease(number, this.source, this.published, this.features)
  }
  async refresh() {
    this.detailReads.clear()
    const result = await this.catalog.refresh()
    const personal = await this.features.read()
    for (const feature of Object.values(personal.features)
      .filter((row) => row.savedAt || row.selectedAt || row.chat)
      .slice(0, 200)) {
      try {
        await this.features.observe(
          result.catalog?.pullRequests.find((pr) => pr.number === feature.number) ??
            (await this.catalog.detail(feature.number))
        )
      } catch {
        break
      }
    }
    return result.status
  }
}
let service: CommunityHostService | null = null
export function getCommunityHostService(): CommunityHostService {
  if (!service) {
    service = new CommunityHostService(join(getCanonicalUserDataPath(), 'community'))
    getAppEnvironment().onWillQuit(() => service?.catalog.cancel())
  }
  return service
}
