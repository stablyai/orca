// Clear the launching terminal’s inherited Orca identity so test branches depend on fixture env, not which agent launched runner.
for (const name of [
  'ORCA_AGENT_SESSION_ID',
  'ORCA_STRUCTURED_SESSION',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKSPACE_ID'
]) {
  delete process.env[name]
}
