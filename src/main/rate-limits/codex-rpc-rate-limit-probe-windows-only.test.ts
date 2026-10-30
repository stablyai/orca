import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { WINDOWS_ONLY_AGENT_CLI_DIR } from '../codex-cli/windows-only-agent-cli'
import {
  readCodexRateLimitsViaRpc,
  type CodexRpcRateLimitChild
} from './codex-rpc-rate-limit-probe'

it('reports a Windows-only Codex as unavailable, with the WSL wording', async () => {
  const child: CodexRpcRateLimitChild & EventEmitter = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn() })
  })
  const probe = readCodexRateLimitsViaRpc({
    child,
    codexCommand: `${WINDOWS_ONLY_AGENT_CLI_DIR}/codex`,
    initTimeoutMs: 30_000,
    rpcTimeoutMs: 10_000,
    terminate: async () => {}
  })
  child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
  await expect(probe).resolves.toMatchObject({
    status: 'unavailable',
    error:
      'Codex is installed only on Windows, not in this WSL distro. Install it inside the distro.'
  })
})
