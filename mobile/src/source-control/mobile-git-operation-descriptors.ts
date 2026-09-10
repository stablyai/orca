import {
  defineRpcOperation,
  type RpcOperationDescriptor
} from '../transport/rpc-operation-descriptor'

export const mobileGitOperationDescriptors: Readonly<
  Record<string, RpcOperationDescriptor<string>>
> = {
  'git.abortMerge': defineRpcOperation({ method: 'git.abortMerge', policy: 'unclassified' }),
  'git.abortRebase': defineRpcOperation({ method: 'git.abortRebase', policy: 'unclassified' }),
  'git.branchCompare': defineRpcOperation({ method: 'git.branchCompare', policy: 'unclassified' }),
  'git.branchDiff': defineRpcOperation({ method: 'git.branchDiff', policy: 'unclassified' }),
  'git.bulkStage': defineRpcOperation({ method: 'git.bulkStage', policy: 'unclassified' }),
  'git.bulkUnstage': defineRpcOperation({ method: 'git.bulkUnstage', policy: 'unclassified' }),
  'git.cancelGenerateCommitMessage': defineRpcOperation({
    method: 'git.cancelGenerateCommitMessage',
    policy: 'unclassified'
  }),
  'git.checkout': defineRpcOperation({ method: 'git.checkout', policy: 'unclassified' }),
  'git.commit': defineRpcOperation({ method: 'git.commit', policy: 'unclassified' }),
  'git.commitCompare': defineRpcOperation({ method: 'git.commitCompare', policy: 'unclassified' }),
  'git.discard': defineRpcOperation({ method: 'git.discard', policy: 'unclassified' }),
  'git.fastForward': defineRpcOperation({ method: 'git.fastForward', policy: 'unclassified' }),
  'git.fetch': defineRpcOperation({ method: 'git.fetch', policy: 'unclassified' }),
  'git.generateCommitMessage': defineRpcOperation({
    method: 'git.generateCommitMessage',
    policy: 'unclassified'
  }),
  'git.history': defineRpcOperation({ method: 'git.history', policy: 'unclassified' }),
  'git.localBranches': defineRpcOperation({ method: 'git.localBranches', policy: 'unclassified' }),
  'git.pull': defineRpcOperation({ method: 'git.pull', policy: 'unclassified' }),
  'git.push': defineRpcOperation({ method: 'git.push', policy: 'unclassified' }),
  'git.rebaseFromBase': defineRpcOperation({
    method: 'git.rebaseFromBase',
    policy: 'unclassified'
  }),
  'git.stage': defineRpcOperation({ method: 'git.stage', policy: 'unclassified' }),
  'git.status': defineRpcOperation({ method: 'git.status', policy: 'unclassified' }),
  'git.unstage': defineRpcOperation({ method: 'git.unstage', policy: 'unclassified' }),
  'git.upstreamStatus': defineRpcOperation({ method: 'git.upstreamStatus', policy: 'unclassified' })
}
