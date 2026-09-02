import { ipcRenderer } from 'electron'
import type { HostedReviewForBranchArgs } from '../../shared/hosted-review'

export const hostedReviewApi = {
  forBranch: (args: HostedReviewForBranchArgs): Promise<unknown> =>
    ipcRenderer.invoke('hostedReview:forBranch', args),
  getCreationEligibility: (args: unknown): Promise<unknown> =>
    ipcRenderer.invoke('hostedReview:getCreationEligibility', args),
  create: (args: unknown): Promise<unknown> => ipcRenderer.invoke('hostedReview:create', args),
  createStacked: (args: unknown): Promise<unknown> =>
    ipcRenderer.invoke('hostedReview:createStacked', args)
}
