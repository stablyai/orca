import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const referenceRoot = resolve(
  import.meta.dirname,
  '../../skill-guides/orca-per-workspace-env/references'
)
const ssh = await readFile(resolve(referenceRoot, 'ssh-host.md'), 'utf8')

async function runShell(script, env = {}) {
  try {
    const output = await run('bash', ['-c', script], {
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ...env }
    })
    return { ...output, code: 0 }
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code }
  }
}

describe.skipIf(process.platform === 'win32')('recipe shell examples', () => {
  it('uses host credentials and refuses unverified SSH hosts without forwarding tokens', async () => {
    const script = ssh.match(/```bash\n(#!\/usr\/bin\/env bash[\s\S]*?)\n```/u)?.[1]
    expect(script).toBeDefined()
    const sync = script.slice(0, script.indexOf('# 2. print'))
    const result = await runShell(
      `ssh() { printf '%s\\n' "$@"; }
ssh_username=worker
host=example.test
ssh_port=2222
project_root='/remote/path with spaces'
repo_url=https://example.test/org/repo.git
repo_ref=main
${sync}`,
      { GH_TOKEN: 'test-token-must-not-be-forwarded' }
    )
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('StrictHostKeyChecking=yes')
    expect(result.stderr).toContain('BatchMode=yes')
    expect(result.stderr).not.toContain('test-token-must-not-be-forwarded')
    expect(result.stderr).not.toContain('GH_TOKEN=')
    expect(script).toContain('export GIT_TERMINAL_PROMPT=0')
  })
})
