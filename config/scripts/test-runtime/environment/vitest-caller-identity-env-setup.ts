// Clear the launching terminal’s inherited Orca identity so test branches depend on fixture env, not which agent launched runner.
// Clear the launching terminal's identity too: macOS /etc/zshrc and /etc/bashrc source /etc/{zsh,bash}rc_$TERM_PROGRAM.
for (const name of [
  'ORCA_AGENT_SESSION_ID',
  'ORCA_STRUCTURED_SESSION',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKSPACE_ID',
  'ORCA_RUNTIME_SOURCE_ID',
  'ORCA_RUNTIME_SOURCE_INCARNATION',
  'ORCA_RUNTIME_SOURCE_PROFILE_PATH',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID'
]) {
  delete process.env[name]
}
