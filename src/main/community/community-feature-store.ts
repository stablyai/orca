import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  communityFeatureSchema as feature,
  communityFeatureStateSchema as schema,
  type CommunityFeatureState as State
} from './community-feature-record'
import type { CommunityPullRequest } from '../../shared/community-catalog'
import type {
  CommunityEvidenceSignals,
  CommunityReleaseProof,
  CommunityFeature,
  CommunityFeatureAction,
  CommunityFeatureEvent,
  CommunityFeatureHistoryPage,
  CommunityFeaturesSnapshot
} from '../../shared/community-features'
import { writeCommunityJson } from './community-json-file'

type ObservedSource = Pick<
  CommunityPullRequest,
  'number' | 'title' | 'headSha' | 'state' | 'observedAt' | 'imageUrls'
>

export class CommunityFeatureStore {
  private state: State = { version: 1, revision: 0, features: {}, events: [] }
  private loaded: Promise<void> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private initialize(): Promise<void> {
    return (this.loaded ??= this.load())
  }

  private async load(): Promise<void> {
    try {
      const file = await open(join(this.root, 'features.json'), 'r')
      try {
        if ((await file.stat()).size > 64 * 1024 * 1024) {
          throw new Error(
            'Community feature history exceeds its supported size. Existing data was not changed.'
          )
        }
        this.state = schema.parse(JSON.parse(await file.readFile('utf8')))
      } finally {
        await file.close()
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }

  async read(): Promise<CommunityFeaturesSnapshot> {
    await this.initialize()
    await this.writes
    return { revision: this.state.revision, features: this.state.features }
  }

  async history(number: number, before?: number, limit = 50): Promise<CommunityFeatureHistoryPage> {
    await this.initialize()
    await this.writes
    const rows = this.state.events
      .toReversed()
      .filter((e) => e.number === number && (!before || e.revision < before))
    const events = rows.slice(0, Math.min(100, Math.max(1, limit)))
    return { events, nextBefore: rows.length > events.length ? events.at(-1)!.revision : null }
  }

  private empty(number: number): CommunityFeature {
    return {
      number,
      evidenceId: null,
      candidate: null,
      installed: null,
      signals: null,
      release: null,
      savedAt: null,
      selectedAt: null,
      visit: null,
      chat: null,
      source: null
    }
  }

  private async commit(
    number: number,
    change: (current: CommunityFeature, at: string) => CommunityFeature,
    details: Pick<CommunityFeatureEvent, 'kind' | 'actor' | 'summary'> & { headSha?: string },
    evidence: string[] = []
  ): Promise<CommunityFeaturesSnapshot> {
    await this.initialize()
    const write = this.writes.then(async () => {
      const before = this.state.features[number] ?? this.empty(number)
      const at = this.now().toISOString()
      const after = feature.parse(change(before, at))
      if (JSON.stringify(before) === JSON.stringify(after)) {
        return
      }
      const revision = this.state.revision + 1
      const next: State = {
        version: 1,
        revision,
        features: { ...this.state.features, [number]: after },
        events: [
          ...this.state.events,
          {
            id: randomUUID(),
            revision,
            number,
            at,
            ...details,
            headSha: details.headSha ?? after.source?.headSha ?? after.visit?.headSha ?? null,
            evidence
          }
        ]
      }
      if (Buffer.byteLength(JSON.stringify(next)) > 64 * 1024 * 1024) {
        throw new Error('Community feature history is full. Existing history was retained.')
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await writeCommunityJson(join(this.root, 'features.json'), next, true)
      this.state = next
    })
    this.writes = write.catch(() => {})
    await write
    return { revision: this.state.revision, features: this.state.features }
  }

  mutate(action: CommunityFeatureAction): Promise<CommunityFeaturesSnapshot> {
    const summaries = {
      save: 'Saved proposal',
      unsave: 'Removed saved marker',
      select: 'Selected for Custom',
      unselect: 'Removed from selected additions',
      visit: 'Viewed source version',
      'link-chat': 'Linked native feature conversation'
    }
    return this.commit(
      action.number,
      (current, at) => {
        switch (action.action) {
          case 'save':
            return { ...current, savedAt: current.savedAt ?? at }
          case 'unsave':
            return { ...current, savedAt: null }
          case 'select':
            return { ...current, selectedAt: current.selectedAt ?? at }
          case 'unselect':
            return { ...current, selectedAt: null }
          case 'visit':
            return { ...current, visit: { headSha: action.headSha, at } }
          case 'link-chat':
            return { ...current, chat: action.chat }
        }
      },
      { kind: action.action, actor: 'user', summary: summaries[action.action] }
    )
  }

  recordRunningBuild(
    number: number,
    installed: Omit<NonNullable<CommunityFeature['installed']>, 'observedAt'>
  ): Promise<CommunityFeaturesSnapshot> {
    return this.commit(
      number,
      (current, at) =>
        current.installed?.buildId === installed.buildId &&
        current.installed.headSha === installed.headSha
          ? current
          : { ...current, installed: { ...installed, observedAt: at } },
      {
        kind: 'running-build-observed',
        actor: 'build',
        headSha: installed.headSha,
        summary: `Observed this feature in running Custom build ${installed.buildId}`
      }
    )
  }

  recordCandidate(
    number: number,
    candidate: NonNullable<CommunityFeature['candidate']>,
    evidence: string[] = []
  ): Promise<CommunityFeaturesSnapshot> {
    return this.commit(
      number,
      (current) =>
        current.candidate?.id === candidate.id &&
        current.candidate.state === candidate.state &&
        current.candidate.headSha === candidate.headSha &&
        current.candidate.url === candidate.url
          ? current
          : { ...current, candidate },
      {
        kind: 'candidate-state',
        actor: 'build',
        headSha: candidate.headSha,
        summary: `Candidate ${candidate.id}: ${candidate.state}`
      },
      [...(candidate.url ? [candidate.url] : []), ...evidence]
    )
  }

  recordEvidence(
    number: number,
    id: string,
    signals: CommunityEvidenceSignals
  ): Promise<CommunityFeaturesSnapshot> {
    return this.commit(
      number,
      (current) => (current.evidenceId === id ? current : { ...current, evidenceId: id, signals }),
      {
        kind: 'evidence-captured',
        actor: 'github',
        summary: 'Captured PR description, checks, and reviews'
      },
      [id]
    )
  }

  recordRelease(number: number, proof: CommunityReleaseProof): Promise<CommunityFeaturesSnapshot> {
    return this.commit(
      number,
      (current) =>
        current.release?.tag === proof.tag && current.release.releaseCommit === proof.releaseCommit
          ? current
          : { ...current, release: proof },
      {
        kind: 'official-release',
        actor: 'github',
        summary: `Verified source inclusion in official ${proof.tag}`
      },
      [proof.url, proof.comparisonUrl]
    )
  }

  observe(source: ObservedSource): Promise<CommunityFeaturesSnapshot> {
    return this.commit(
      source.number,
      (current, at) =>
        current.source?.headSha === source.headSha &&
        current.source.state === (source.state ?? 'open') &&
        current.source.title === source.title &&
        JSON.stringify(current.source.imageUrls) === JSON.stringify(source.imageUrls)
          ? current
          : {
              ...current,
              source: {
                title: source.title,
                headSha: source.headSha,
                state: source.state ?? 'open',
                observedAt: source.observedAt ?? at,
                imageUrls: source.imageUrls
              }
            },
      { kind: 'source-observed', actor: 'github', summary: 'Captured GitHub source state' }
    )
  }
}
