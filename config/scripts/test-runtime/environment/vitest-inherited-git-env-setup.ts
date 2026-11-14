// A hook's repo-locating Git env would aim real-Git suites at the outer repo; keep GIT_EXEC_PATH and config, which the compat lane sets.
for (const name of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH'
]) {
  delete process.env[name]
}
