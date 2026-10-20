import { defineMethod } from '../core'
import {
  PerforceChangelist,
  PerforceChangelistFiles,
  PerforceCopy,
  PerforceCopyUp,
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
    permission: 'workspace',
    params: PerforceWorktree,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'detect', params)
  }),
  defineMethod({
    name: 'perforce.info',
    permission: 'workspace',
    params: PerforceWorktree,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'info', params)
  }),
  defineMethod({
    name: 'perforce.status',
    permission: 'workspace',
    params: PerforceWorktree,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'status', params)
  }),
  defineMethod({
    name: 'perforce.history',
    permission: 'workspace',
    params: PerforceHistory,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'history', params)
  }),
  defineMethod({
    name: 'perforce.diff',
    permission: 'workspace',
    params: PerforceFile,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'diff', params)
  }),
  defineMethod({
    name: 'perforce.diffText',
    permission: 'workspace',
    params: PerforceFiles,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'diffText', params)
  }),
  defineMethod({
    name: 'perforce.isReadOnlyFile',
    permission: 'workspace',
    params: PerforceFile,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'isReadOnlyFile', params)
  }),
  defineMethod({
    name: 'perforce.checkoutIfReadOnly',
    permission: 'workspace',
    params: PerforceFile,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'checkoutIfReadOnly', params)
  }),
  defineMethod({
    name: 'perforce.open',
    permission: 'workspace',
    params: PerforceFiles,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'open', params)
  }),
  defineMethod({
    name: 'perforce.edit',
    permission: 'workspace',
    params: PerforceFiles,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'edit', params)
  }),
  defineMethod({
    name: 'perforce.close',
    permission: 'workspace',
    params: PerforceFiles,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'close', params)
  }),
  defineMethod({
    name: 'perforce.discard',
    permission: 'workspace',
    params: PerforceDiscard,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'discard', params)
  }),
  defineMethod({
    name: 'perforce.submit',
    permission: 'workspace',
    params: PerforceSubmit,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'submit', params)
  }),
  defineMethod({
    name: 'perforce.sync',
    permission: 'workspace',
    params: PerforceWorktree,
    handler: (params, { runtime }) => runtime.runPerforceOperation(params.worktree, 'sync', params)
  }),
  defineMethod({
    name: 'perforce.shelve',
    permission: 'workspace',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'shelve', params)
  }),
  defineMethod({
    name: 'perforce.unshelve',
    permission: 'workspace',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'unshelve', params)
  }),
  defineMethod({
    name: 'perforce.unshelveFrom',
    permission: 'workspace',
    params: PerforceUnshelveFrom,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'unshelveFrom', params)
  }),
  defineMethod({
    name: 'perforce.shelveAndRevertFiles',
    permission: 'workspace',
    params: PerforceChangelistFiles,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'shelveAndRevertFiles', params)
  }),
  defineMethod({
    name: 'perforce.unshelveFiles',
    permission: 'workspace',
    params: PerforceShelvedFiles,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'unshelveFiles', params)
  }),
  defineMethod({
    name: 'perforce.deleteShelf',
    permission: 'workspace',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'deleteShelf', params)
  }),
  defineMethod({
    name: 'perforce.deleteChangelistWithFiles',
    permission: 'workspace',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'deleteChangelistWithFiles', params)
  }),
  defineMethod({
    name: 'perforce.createChangelist',
    permission: 'workspace',
    params: PerforceCreateChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'createChangelist', params)
  }),
  defineMethod({
    name: 'perforce.editDescription',
    permission: 'workspace',
    params: PerforceEditDescription,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'editDescription', params)
  }),
  defineMethod({
    name: 'perforce.moveToChangelist',
    permission: 'workspace',
    params: PerforceMoveToChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'moveToChangelist', params)
  }),
  defineMethod({
    name: 'perforce.deleteChangelist',
    permission: 'workspace',
    params: PerforceChangelist,
    handler: (params, { runtime }) =>
      runtime.runPerforceOperation(params.worktree, 'deleteChangelist', params)
  }),
  defineMethod({
    name: 'perforce.generateDescription',
    permission: 'workspace',
    params: PerforceGenerateDescription,
    handler: (params, { runtime }) => runtime.generatePerforceDescription(params.worktree, params)
  }),
  defineMethod({
    name: 'perforce.copyReadiness',
    permission: 'workspace',
    params: PerforceProject,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'copyReadiness', params)
  }),
  defineMethod({
    name: 'perforce.listCopyStreams',
    permission: 'workspace',
    params: PerforceProject,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'listCopyStreams', params)
  }),
  defineMethod({
    name: 'perforce.detectProject',
    permission: 'workspace',
    params: PerforceProject,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'detectProject', params)
  }),
  defineMethod({
    name: 'perforce.syncCopies',
    permission: 'workspace',
    params: PerforceProject,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'syncCopies', params)
  }),
  defineMethod({
    name: 'perforce.previewCopyRemoval',
    permission: 'workspace',
    params: PerforceCopy,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'previewCopyRemoval', params)
  }),
  defineMethod({
    name: 'perforce.removeCopy',
    permission: 'workspace',
    params: PerforceRemoveCopy,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'removeCopy', params)
  }),
  defineMethod({
    name: 'perforce.previewCopyUp',
    permission: 'workspace',
    params: PerforceCopy,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'previewCopyUp', params)
  }),
  defineMethod({
    name: 'perforce.copyUp',
    permission: 'workspace',
    params: PerforceCopyUp,
    handler: (params, { runtime }) =>
      runtime.runPerforceCopyOperation(params.repo, 'copyUp', params)
  })
]
