import { expect, it } from 'vitest'
import { codexSpawnEnoent, WINDOWS_ONLY_AGENT_CLI_DIR } from './windows-only-agent-cli'

it('words a Codex spawn ENOENT by what was resolved', () => {
  expect(codexSpawnEnoent(`${WINDOWS_ONLY_AGENT_CLI_DIR}/codex`)).toEqual({
    message:
      'Codex is installed only on Windows, not in this WSL distro. Install it inside the distro.',
    missing: true
  })
  expect(codexSpawnEnoent('codex')).toEqual({ message: 'Codex CLI not found.', missing: true })
  expect(codexSpawnEnoent('/usr/lib/node_modules/codex/bin/codex.js').missing).toBe(false)
})
