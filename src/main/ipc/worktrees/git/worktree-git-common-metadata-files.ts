// Keep native and polling paths aligned: logs/HEAD moves heads, config.worktree marks sparse state, config sets upstreams.
export const PRIMARY_CHECKOUT_METADATA_FILES = [
  'HEAD',
  'packed-refs',
  'index',
  'config',
  'config.worktree',
  'logs/HEAD'
]
