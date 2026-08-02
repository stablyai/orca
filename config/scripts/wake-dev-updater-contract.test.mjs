import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Orca Wake Dev updater isolation', () => {
  it('guards deferred setup, every updater mutation IPC, and menu checks', async () => {
    const [services, main] = await Promise.all([
      readFile('src/main/window/attach-main-window-services.ts', 'utf8'),
      readFile('src/main/index.ts', 'utf8')
    ])

    expect(services).toContain('if (isWakeDevRuntime()) {\n    pendingAutoUpdaterSetup = null')
    expect(services).toContain('const disabled = isWakeDevRuntime()')
    expect(services).toContain('disabled ? undefined : downloadUpdate()')
    expect(services).toContain('disabled ? undefined : quitAndInstall()')
    expect(services).toContain("message: 'Updates are disabled in Orca Wake Dev.'")
    expect(main).toContain(
      'if (isWakeDevRuntime()) {\n    return\n  }\n  ensureAutoUpdaterConfigured()'
    )
  })

  it('requires a fresh flagged process and verifies flags before the wake exercise', async () => {
    const guide = await readFile('docs/readme/orca-wake-dev-functional-test.md', 'utf8')

    expect(guide).toContain(`osascript -e 'quit app "Orca Wake Dev"'`)
    expect(guide).toContain('"/Applications/Orca Wake Dev.app/Contents/MacOS/Orca Wake Dev" &')
    expect(guide).toContain('ORCA_FEATURE_CODEX_CONTROLLED_LAUNCH=1')
    expect(guide).toContain('ORCA_FEATURE_CODEX_CONTROLLED_PROVIDER=1')
    expect(guide).toContain('ORCA_FEATURE_ORCHESTRATION_CONVERSATION_WAKE=1')
    expect(guide).toContain('ps eww -p "$WAKE_DEV_PID"')
    expect(guide).toContain(
      [
        'ORCA_DISABLE_CODEX_CONTROLLED_SESSION=1 \\',
        'ORCA_DISABLE_ORCHESTRATION_CONVERSATION_WAKE=1 \\',
        '  "/Applications/Orca Wake Dev.app/Contents/MacOS/Orca Wake Dev" &'
      ].join('\n')
    )
    expect(guide).not.toContain('export ORCA_DISABLE_CODEX_CONTROLLED_SESSION=1')
    expect(guide).not.toContain('open -a "Orca Wake Dev"')
  })

  it('stops the documented flag check when a required flag is absent', async () => {
    const guide = await readFile('docs/readme/orca-wake-dev-functional-test.md', 'utf8')
    const loop = guide.match(
      /```bash\n(for flag in \\\n  ORCA_FEATURE_CODEX_CONTROLLED_LAUNCH[\s\S]*?\ndone)\n```/
    )?.[1]

    expect(loop).toBeDefined()
    expect(runFlagCheck(loop, allWakeFlags).status).toBe(0)
    const missingFlag = runFlagCheck(
      loop,
      'ORCA_FEATURE_CODEX_CONTROLLED_LAUNCH=1 ORCA_FEATURE_CODEX_CONTROLLED_PROVIDER=1'
    )
    expect(missingFlag.status).toBe(1)
    expect(missingFlag.stderr).toContain('ORCA_FEATURE_ORCHESTRATION_CONVERSATION_WAKE=1 missing')
  })
})

const allWakeFlags =
  'ORCA_FEATURE_CODEX_CONTROLLED_LAUNCH=1 ORCA_FEATURE_CODEX_CONTROLLED_PROVIDER=1 ORCA_FEATURE_ORCHESTRATION_CONVERSATION_WAKE=1'

function runFlagCheck(loop, processEnvironment) {
  return spawnSync(
    'sh',
    ['-c', `ps() { printf '%s\\n' '${processEnvironment}'; }\nWAKE_DEV_PID=1\n${loop}`],
    {
      encoding: 'utf8'
    }
  )
}
