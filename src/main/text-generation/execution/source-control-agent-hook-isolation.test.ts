import { afterAll, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSourceControlAgent } from './source-control-agent-launch'

const folder = mkdtempSync(join(tmpdir(), 'orca-generation-hook-isolation-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

it('keeps background generation from reporting hooks against the launching terminal', async () => {
  const agent = join(folder, 'report-environment.cjs')
  writeFileSync(
    agent,
    `process.stdin.resume()
console.log(JSON.stringify({
  pane: process.env.ORCA_PANE_KEY ?? null,
  fallbackPane: process.env.ORCA_AGENT_PANE ?? null,
  launch: process.env.ORCA_AGENT_LAUNCH_TOKEN ?? null,
  endpoint: process.env.ORCA_AGENT_HOOK_ENDPOINT ?? null,
  port: process.env.ORCA_AGENT_HOOK_PORT ?? null,
  disabled: process.env.ORCA_AGENT_HOOKS_DISABLED,
  home: process.env.CODEX_HOME
}))
`
  )
  const child = spawnSourceControlAgent({
    binary: process.execPath,
    args: [agent],
    cwd: folder,
    env: {
      ...process.env,
      ORCA_PANE_KEY: 'dev-tab:dev-pane',
      ORCA_AGENT_PANE: 'dev-tab:dev-pane',
      ORCA_AGENT_LAUNCH_TOKEN: 'parent-launch',
      ORCA_AGENT_HOOK_ENDPOINT: '/parent/hook.sock',
      ORCA_AGENT_HOOK_PORT: '57279',
      ORCA_AGENT_HOOKS_DISABLED: '0',
      CODEX_HOME: join(folder, 'managed-home')
    },
    stdinMode: 'pipe',
    useCwdForNative: true
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => (stdout += chunk.toString()))
  child.stderr?.on('data', (chunk) => (stderr += chunk.toString()))
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('close', resolve)
    child.on('error', reject)
  })
  child.stdin?.end()

  expect(await closed, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    pane: null,
    fallbackPane: null,
    launch: null,
    endpoint: null,
    port: null,
    disabled: '1',
    home: join(folder, 'managed-home')
  })
})
