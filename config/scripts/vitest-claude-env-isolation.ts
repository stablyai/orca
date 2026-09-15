// Why: a host Claude Code session exports CLAUDE_CONFIG_DIR and Orca honours it, so
// runtime-auth tests that believe they use a temp dir delete and rewrite the
// developer's real credentials. Tests that need the variable set it themselves.
delete process.env.CLAUDE_CONFIG_DIR
