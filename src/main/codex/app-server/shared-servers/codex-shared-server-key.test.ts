import { describe, expect, it } from 'vitest'
import { codexSharedServerSpec } from './codex-shared-server-key'

const launch = (cwd: string, args: string[]) => ({
  command: '/usr/local/bin/codex',
  args: ['app-server', ...args],
  cwd,
  env: { CODEX_HOME: '/home/a/.codex' }
})

describe('shared Codex server key', () => {
  it("shares across folders with Orca's own hooks-off override", async () => {
    const hooksOff = ['-c', 'hooks.state={"/home/a/.codex/hooks.json:x"={enabled=false}}']
    const a = await codexSharedServerSpec(launch('/repo/wt-a', hooksOff), [])
    const b = await codexSharedServerSpec(launch('/repo/wt-b', hooksOff), [])
    expect(a.key).toBe(b.key)
  })

  it('keeps the folder for a user --config value Codex may resolve from it', async () => {
    const config = ['-c', 'model_instructions_file="./AGENTS.extra.md"']
    const a = await codexSharedServerSpec(launch('/repo/wt-a', config), [])
    const b = await codexSharedServerSpec(launch('/repo/wt-b', config), [])
    expect(a.key).not.toBe(b.key)
    expect(a.launch.cwd).toBe('/repo/wt-a')
  })
})
