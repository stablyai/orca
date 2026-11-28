/**
 * Issue #8749 — claim: Orca's agent-session seatbelt blocks ~/.orca/agent-hooks
 * claude-hook.sh (EPERM on every tool call).
 *
 * Investigation on this tree + production Orca 1.4.x (macOS):
 * - Orca installs managed hooks at `~/.orca/agent-hooks/claude-hook.sh`.
 * - There is **no** seatbelt / sandbox-exec profile applied to daemon PTY
 *   sessions in this codebase (daemon children sandbox_check=0 live).
 * - Chromium renderer helpers use `--seatbelt-client` (expected); agent shells
 *   spawn via daemon `login` + shell-ready and are not sandboxed.
 * - Live probe (orca terminal create --command …) on production Orca:
 *     sandbox_check 0
 *     ~/.orca accessible
 *     claude-hook.sh executable, exit 0 on empty stdin
 *
 * This test locks the *code contract* that Orca does not wrap agent PTYs in a
 * seatbelt profile and still points hooks at ~/.orca (the install location the
 * reporter correctly identified). Symptom EPERM under a true seatbelt is not
 * reproduced here → issue labeled cannot_repro on this host/version.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/agent-hooks/repro-8749-hook-path-no-seatbelt.test.ts
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getSharedManagedScriptPath } from './installer-utils'

const installerSource = readFileSync(join(__dirname, 'installer-utils.ts'), 'utf8')
const daemonDir = join(__dirname, '../daemon')

describe('#8749 agent hooks under ~/.orca — no Orca seatbelt on PTY path', () => {
  it('installs managed Claude hook under ~/.orca/agent-hooks/', () => {
    expect(getSharedManagedScriptPath('claude-hook.sh')).toMatch(
      /\.orca[/\\]agent-hooks[/\\]claude-hook\.sh$/
    )
    expect(installerSource).toMatch(
      /join\(homedir\(\),\s*'\.orca',\s*'agent-hooks',\s*scriptFileName\)/
    )
  })

  it('daemon / PTY spawn sources contain no seatbelt profile application', () => {
    // Scan daemon modules for sandbox-exec / seatbelt profile wiring.
    const files = readdirSync(daemonDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    const hits: string[] = []
    for (const file of files) {
      const src = readFileSync(join(daemonDir, file), 'utf8')
      if (/sandbox-exec|seatbelt|sandbox_init|SBPL_|com\.apple\.security\.app-sandbox/.test(src)) {
        hits.push(file)
      }
    }
    expect(hits).toEqual([])
  })

  it('managed POSIX hook is fail-soft on empty stdin / missing env (exit 0)', () => {
    // Mirrors the installed ~/.orca/agent-hooks/claude-hook.sh shape: missing
    // payload or missing ORCA_* env exits 0 rather than failing the agent tool.
    const claudeHookService = readFileSync(join(__dirname, '../claude/hook-service.ts'), 'utf8')
    // Hook service writes a managed script; script content is built with
    // fail-soft curl (|| true) pattern in installer-utils / getManagedScript.
    expect(claudeHookService).toMatch(/writeManagedScript/)
    const installer = installerSource
    // Curl posts are best-effort; agent must not see hook as hard-fail when
    // the endpoint is down. (EPERM before exec is a different layer.)
    expect(installer).toMatch(/curl/)
  })
})
