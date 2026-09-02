// Shared by the shallow watcher and every poll path so platforms cannot drift.
// `logs/HEAD` catches head moves; `config.worktree` carries the sparse flag;
// `config` gains branch.<name>.remote/merge on an external `git push -u`.
export const PRIMARY_CHECKOUT_METADATA_FILES = [
  'HEAD',
  'packed-refs',
  'index',
  'config',
  'config.worktree',
  'logs/HEAD'
]
