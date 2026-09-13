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
const vercel = await readFile(resolve(referenceRoot, 'provider-vercel.md'), 'utf8')
const ssh = await readFile(resolve(referenceRoot, 'ssh-host.md'), 'utf8')
const cleanup = vercel.match(/```bash\n(cleanup_snapshot\(\) \{[\s\S]*?\n\})\n```/u)?.[1]

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
  it.each(['base', 'auth'])('cleans the %s sandbox on failure and success', async (phase) => {
    expect(cleanup).toBeDefined()
    const trap = vercel.match(new RegExp(`trap 'cleanup_snapshot "\\$${phase}"' EXIT`, 'u'))?.[0]
    expect(trap).toBeDefined()
    expect(vercel.indexOf(trap)).toBeLessThan(
      vercel.indexOf(`vercel sandbox create --name "$${phase}"`)
    )
    for (const exitCode of [0, 7]) {
      const result = await runShell(`set -euo pipefail
${cleanup}
vercel_args=(--scope test-scope)
${phase}=unique-test-sandbox
vercel() { printf '%s\\n' "$@"; }
${trap}
exit ${exitCode}`)
      expect(result.code).toBe(exitCode)
      expect(result.stderr).toBe('sandbox\nremove\nunique-test-sandbox\n--scope\ntest-scope\n')
    }
  })

  it('reports failed cleanup even after an otherwise successful snapshot', async () => {
    const result = await runShell(`set -euo pipefail
${cleanup}
vercel_args=()
vercel() { return 9; }
trap 'cleanup_snapshot unique-test-sandbox' EXIT
exit 0`)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Sandbox cleanup failed for unique-test-sandbox')
  })

  it('disables Git prompts when the Vercel token is absent', async () => {
    const prefix = vercel.match(
      /-- bash -lc 'set -euo pipefail; cd "\$ORCA_PROJECT_ROOT"; \\\n([\s\S]*?)    git fetch/u
    )?.[1]
    expect(prefix).toBeDefined()
    const result = await runShell(
      `set -euo pipefail\nunset GH_TOKEN\n${prefix}\nprintf '%s' "$GIT_TERMINAL_PROMPT"`
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('0')
  })

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
