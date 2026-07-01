import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { getShellReadyLaunchConfig } from '../../local-pty-shell-ready'
import { escapeRegex } from '../../../../shared/string-utils'

const RUN_MARKER = /^[ \t]*#[ \t]*Run:.*$/m

/**
 * Shell-script-literal test framework for shell-ready tests.
 *
 * Takes shell scripts as string literals that can be literally copy-pasted
 * into a terminal to replicate the test scenario.
 *
 * Example:
 * ```typescript
 * const { stdout } = await shellScriptTest(`
 *   mkdir -p ~/.config/zsh
 *   cat > ~/.zshenv <<'EOF'
 * export ZDOTDIR="$HOME/.config/zsh"
 * EOF
 *
 *   zsh -c 'env | grep ZDOTDIR'
 * `, { userDataPath })
 * expect(stdout).toMatchInlineSnapshot(...)
 * ```
 */

export type ShellScriptTestResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type ShellScriptTestOptions = {
  userDataPath?: string
  shell?: string
}

function detectShellFromCommand(command: string, fallback: string): string {
  const shellMatch = command.match(/(?:^|\s)((?:\/[\w/-]+\/)?(?:zsh|bash|sh))\s/)
  return shellMatch ? shellMatch[1] : fallback
}

export async function shellScriptTest(
  script: string,
  options: ShellScriptTestOptions = {}
): Promise<ShellScriptTestResult> {
  const testHome = mkdtempSync(join(tmpdir(), 'shell-test-home-'))
  const userDataPath = options.userDataPath || mkdtempSync(join(tmpdir(), 'shell-test-userdata-'))
  const cleanupUserDataPath = !options.userDataPath

  try {
    const parts = script.split(RUN_MARKER)
    const hasRunMarker = parts.length === 2
    const setupScript = hasRunMarker ? parts[0].trim() : ''
    const runScript = hasRunMarker ? parts[1].trim() : script.trim()

    const wrapperShell = detectShellFromCommand(runScript, options.shell || '/bin/zsh')
    const config = getShellReadyLaunchConfig(wrapperShell)

    const env: Record<string, string> = {
      ...config.env,
      // Why: the framework creates user startup files under testHome after
      // computing the wrapper config; route wrapper discovery to that fixture.
      HOME: testHome,
      ORCA_ORIG_ZDOTDIR: testHome,
      ORCA_ZSHENV_SOURCE_DIR: testHome
    }

    const spawnOptions = {
      env: env as NodeJS.ProcessEnv,
      cwd: testHome,
      encoding: 'utf8' as const
    }

    if (setupScript) {
      const setupPath = join(testHome, '.setup.sh')
      writeFileSync(setupPath, setupScript, 'utf8')
      const setupResult = spawnSync('/bin/bash', [setupPath], spawnOptions)
      if (setupResult.status !== 0) {
        throw new Error(
          `Setup script failed with exit code ${setupResult.status}\nstderr: ${setupResult.stderr}`
        )
      }
    }

    const runPath = join(testHome, '.run.sh')
    writeFileSync(runPath, runScript, 'utf8')
    const shellArgs = config.args ? [...config.args, runPath] : [runPath]
    const result = spawnSync(wrapperShell, shellArgs, spawnOptions)

    const normalizationContext = {
      testHome,
      userDataPath,
      actualUserHome: process.env.HOME || '',
      shellName: basename(wrapperShell).toLowerCase()
    }

    return {
      stdout: normalizeOutput(result.stdout || '', normalizationContext),
      stderr: normalizeOutput(result.stderr || '', normalizationContext),
      exitCode: result.status ?? -1
    }
  } finally {
    rmSync(testHome, { recursive: true, force: true })
    if (cleanupUserDataPath) {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  }
}

const TEMP_PATH_PATTERN =
  /\/(?:var\/folders|tmp)\/[^\s]+?\/(?:shell-test|orca|shell-ready)-[a-z]+-[a-z0-9-]+/g
const PID_PATTERN = /\bpid:\s*\d+/gi

function normalizeOutput(
  output: string,
  ctx: {
    testHome: string
    userDataPath: string
    actualUserHome: string
    shellName: string
  }
): string {
  if (!output) {
    return output
  }

  const wrapperDir = join(ctx.userDataPath, 'shell-ready', ctx.shellName)

  const paths: { path: string; placeholder: string }[] = [
    { path: wrapperDir, placeholder: '<WRAPPER_DIR>' },
    { path: ctx.testHome, placeholder: '<HOME>' }
  ]

  if (ctx.actualUserHome) {
    paths.push({ path: ctx.actualUserHome, placeholder: '<USER_HOME>' })
  }

  const replacements = paths
    .sort((a, b) => b.path.length - a.path.length)
    .map(({ path, placeholder }) => ({
      pattern: new RegExp(escapeRegex(path), 'g'),
      placeholder
    }))

  let normalized = output
  for (const { pattern, placeholder } of replacements) {
    normalized = normalized.replace(pattern, placeholder)
  }

  normalized = normalized.replace(TEMP_PATH_PATTERN, '<TEMP_PATH>')
  normalized = normalized.replace(PID_PATTERN, 'pid: <PID>')

  return normalized
}
