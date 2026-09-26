/**
 * Why: a structured chat exports its own orchestration caller identity to every child, including a
 * test runner it launches. Inherited, it would decide which CLI identity branch a test exercises
 * depending on who ran the suite; suites that need one set it themselves.
 */
for (const name of ['ORCA_AGENT_SESSION_ID', 'ORCA_STRUCTURED_SESSION']) {
  delete process.env[name]
}
