import { defineMethod } from '../core'
import {
  PerforceChangelist,
  PerforceChangelistFiles,
  PerforceCopy,
  PerforceCreateChangelist,
  PerforceDiscard,
  PerforceEditDescription,
  PerforceFile,
  PerforceFiles,
  PerforceGenerateDescription,
  PerforceHistory,
  PerforceMoveToChangelist,
  PerforceProject,
  PerforceRemoveCopy,
  PerforceShelvedFiles,
  PerforceSubmit,
  PerforceUnshelveFrom,
  PerforceWorktree
} from '../../../../shared/rpc-contract/perforce-params'

// Workspace methods are entries of the shared operation table, run where the workspace lives; copy
// methods act on a Perforce folder project and its copies on this host.
export const PERFORCE_METHODS = [
  defineMethod({
    name: 'perforce.detect',
    params: PerforceWorktree,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'detect', params)
  }),
  defineMethod({
    name: 'perforce.info',
    params: PerforceWorktree,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'info', params)
  }),
  defineMethod({
    name: 'perforce.status',
    params: PerforceWorktree,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'status', params)
  }),
  defineMethod({
    name: 'perforce.history',
    params: PerforceHistory,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'history', params)
  }),
  defineMethod({
    name: 'perforce.diff',
    params: PerforceFile,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'diff', params)
  }),
  defineMethod({
    name: 'perforce.diffText',
    params: PerforceFiles,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'diffText', params)
  }),
  defineMethod({
    name: 'perforce.isReadOnlyFile',
    params: PerforceFile,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'isReadOnlyFile', params)
  }),
  defineMethod({
    name: 'perforce.checkoutIfReadOnly',
    params: PerforceFile,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'checkoutIfReadOnly', params)
  }),
  defineMethod({
    name: 'perforce.open',
    params: PerforceFiles,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'open', params)
  }),
  defineMethod({
    name: 'perforce.edit',
    params: PerforceFiles,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'edit', params)
  }),
  defineMethod({
    name: 'perforce.close',
    params: PerforceFiles,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'close', params)
  }),
  defineMethod({
    name: 'perforce.discard',
    params: PerforceDiscard,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'discard', params)
  }),
  defineMethod({
    name: 'perforce.submit',
    params: PerforceSubmit,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'submit', params)
  }),
  defineMethod({
    name: 'perforce.sync',
    params: PerforceWorktree,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'sync', params)
  }),
  defineMethod({
    name: 'perforce.shelve',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'shelve', params)
  }),
  defineMethod({
    name: 'perforce.unshelve',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'unshelve', params)
  }),
  defineMethod({
    name: 'perforce.unshelveFrom',
    params: PerforceUnshelveFrom,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'unshelveFrom', params)
  }),
  defineMethod({
    name: 'perforce.shelveAndRevertFiles',
    params: PerforceChangelistFiles,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'shelveAndRevertFiles', params)
  }),
  defineMethod({
    name: 'perforce.unshelveFiles',
    params: PerforceShelvedFiles,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'unshelveFiles', params)
  }),
  defineMethod({
    name: 'perforce.deleteShelf',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'deleteShelf', params)
  }),
  defineMethod({
    name: 'perforce.deleteChangelistWithFiles',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'deleteChangelistWithFiles', params)
  }),
  defineMethod({
    name: 'perforce.createChangelist',
    params: PerforceCreateChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'createChangelist', params)
  }),
  defineMethod({
    name: 'perforce.editDescription',
    params: PerforceEditDescription,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'editDescription', params)
  }),
  defineMethod({
    name: 'perforce.moveToChangelist',
    params: PerforceMoveToChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'moveToChangelist', params)
  }),
  defineMethod({
    name: 'perforce.deleteChangelist',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'deleteChangelist', params)
  }),
  defineMethod({
    name: 'perforce.generateDescription',
    params: PerforceGenerateDescription,
    handler: (params, { runtime }) => runtime.generatePerforceDescription(params.worktree, params)
  }),
  defineMethod({
    name: 'perforce.copyReadiness',
    params: PerforceProject,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'copyReadiness', params)
  }),
  defineMethod({
    name: 'perforce.listCopyStreams',
    params: PerforceProject,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'listCopyStreams', params)
  }),
  defineMethod({
    name: 'perforce.detectProject',
    params: PerforceProject,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'detectProject', params)
  }),
  defineMethod({
    name: 'perforce.syncCopies',
    params: PerforceProject,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'syncCopies', params)
  }),
  defineMethod({
    name: 'perforce.previewCopyRemoval',
    params: PerforceCopy,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'previewCopyRemoval', params)
  }),
  defineMethod({
    name: 'perforce.removeCopy',
    params: PerforceRemoveCopy,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'removeCopy', params)
  })
]
