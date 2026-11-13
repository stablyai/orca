import { defineMethod } from '../../core'
import { getCommunityHostService } from '../../../../community/community-host-service'
import {
  CommunityCandidateHistoryParams,
  CommunityCandidateIdParams,
  CommunityCandidateDispatchParams,
  CommunityEvidenceParams,
  CommunityDetailParams,
  CommunityNumberParams,
  CommunityHistoryParams,
  CommunityQueryParams,
  CommunityFeatureActionParams,
  CommunityAccountParams
} from '../../../../../shared/rpc-contract/community-params'

export const COMMUNITY_METHODS = [
  defineMethod({
    name: 'community.stageArtifact',
    permission: 'workspace',
    params: CommunityCandidateIdParams,
    handler: ({ id }) => getCommunityHostService().candidates.stageArtifact(id)
  }),
  defineMethod({
    name: 'community.candidateHistory',
    permission: 'workspace',
    params: CommunityCandidateHistoryParams,
    handler: ({ offset }) => getCommunityHostService().candidates.history(offset)
  }),
  defineMethod({
    name: 'community.evidence',
    permission: 'workspace',
    params: CommunityEvidenceParams,
    handler: ({ id }) => getCommunityHostService().evidence.read(id)
  }),
  defineMethod({
    name: 'community.verifyRelease',
    permission: 'workspace',
    params: CommunityNumberParams,
    handler: ({ number }) => getCommunityHostService().verifyRelease(number)
  }),
  defineMethod({
    name: 'community.prepareCandidate',
    permission: 'workspace',
    params: null,
    handler: () => getCommunityHostService().candidates.prepare()
  }),
  defineMethod({
    name: 'community.dispatchCandidate',
    permission: 'workspace',
    params: CommunityCandidateDispatchParams,
    handler: ({ id, repository, ref }) =>
      getCommunityHostService().candidates.dispatch(id, repository, ref)
  }),
  defineMethod({
    name: 'community.candidateStatus',
    permission: 'workspace',
    params: CommunityCandidateIdParams,
    handler: ({ id }) => getCommunityHostService().candidates.status(id)
  }),
  defineMethod({
    name: 'community.list',
    permission: 'workspace',
    params: CommunityQueryParams,
    handler: (params) => getCommunityHostService().list(params)
  }),
  defineMethod({
    name: 'community.detail',
    permission: 'workspace',
    params: CommunityDetailParams,
    handler: ({ number, force }) => getCommunityHostService().detail(number, force)
  }),
  defineMethod({
    name: 'community.features',
    permission: 'workspace',
    params: null,
    handler: () => getCommunityHostService().features.read()
  }),
  defineMethod({
    name: 'community.mutate',
    permission: 'workspace',
    params: CommunityFeatureActionParams,
    handler: (params) => getCommunityHostService().mutate(params)
  }),
  defineMethod({
    name: 'community.history',
    permission: 'workspace',
    params: CommunityHistoryParams,
    handler: ({ number, before, limit }) =>
      getCommunityHostService().features.history(number, before, limit)
  }),
  defineMethod({
    name: 'community.status',
    permission: 'workspace',
    params: null,
    handler: async () => (await getCommunityHostService().catalog.read()).status
  }),
  defineMethod({
    name: 'community.refresh',
    permission: 'workspace',
    params: null,
    handler: () => getCommunityHostService().refresh()
  }),
  defineMethod({
    name: 'community.cancel',
    permission: 'workspace',
    params: null,
    handler: () => getCommunityHostService().catalog.cancel()
  }),
  defineMethod({
    name: 'community.releases',
    permission: 'workspace',
    params: null,
    handler: () => getCommunityHostService().published.releases()
  }),
  defineMethod({
    name: 'community.activity',
    permission: 'workspace',
    params: null,
    handler: () => getCommunityHostService().published.activity()
  }),
  defineMethod({
    name: 'community.accounts',
    permission: 'workspace',
    params: null,
    handler: () => getCommunityHostService().accounts()
  }),
  defineMethod({
    name: 'community.account',
    permission: 'workspace',
    params: CommunityAccountParams,
    handler: ({ user }) => getCommunityHostService().account(user)
  })
]
