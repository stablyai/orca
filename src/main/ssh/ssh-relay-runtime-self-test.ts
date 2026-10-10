/**
 * The 30 s self-test a pinned-Node relay directory passes before launch (design D5):
 * `node --version`, then `relay.js --orca-runtime-selftest <nonce>`.
 *
 * Verdicts follow docs/reference/ssh-execution-boundary.md: a timeout or lost channel is
 * `unverifiable` and never a reason to step down to another runtime; only a classified
 * refusal from a process that actually ran is.
 */
import { randomBytes } from 'node:crypto'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import {
  RELAY_RUNTIME_SELF_TEST_FLAG,
  RELAY_RUNTIME_SELF_TEST_PREFIX,
  type RelayRuntimeSelfTestReport
} from '../../shared/relay-runtime-self-test-report'
import type { SshConnection } from './ssh-connection'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import {
  parseRemoteRuntimeExitReport,
  REMOTE_NODE_RUNTIME_EXIT_PREFIX
} from './orcad-remote-node-runtime'

export const PINNED_RUNTIME_REFUSALS = [
  'noexec',
  'missing_lib',
  'libc_floor',
  'illegal_instruction',
  'wrong_libc',
  // Windows: AV or application control removed, rewrote or blocked verified bytes.
  'security_software'
] as const
export type PinnedRuntimeRefusal = (typeof PINNED_RUNTIME_REFUSALS)[number]

export type PinnedRuntimeSelfTestVerdict =
  | { verdict: 'passed'; report: RelayRuntimeSelfTestReport & { ok: true } }
  | { verdict: 'refused'; refusal: PinnedRuntimeRefusal; detail: string }
  | { verdict: 'unverifiable'; detail: string; cause?: unknown }
  /** It ran and failed in a way no refusal class covers: not proof the runtime cannot work here. */
  | { verdict: 'failed'; detail: string }

export const RELAY_RUNTIME_SELF_TEST_BUDGET_MS = 30_000
const SIGILL_EXIT_STATUS = 128 + 4

/** Map what the loader or shell said to a refusal class; null when nothing matches. */
export function classifyPinnedRuntimeFailure(
  exitStatus: number | null,
  output: string
): PinnedRuntimeRefusal | null {
  if (/contains a virus|potentially unwanted software|missing after upload/i.test(output)) {
    return 'security_software'
  }
  // Windows application control refuses to start binaries under the user profile.
  if (
    /blocked by group policy|Application Control policy|AppLocker|software restriction/i.test(
      output
    )
  ) {
    return 'noexec'
  }
  if (exitStatus === SIGILL_EXIT_STATUS || /illegal instruction/i.test(output)) {
    return 'illegal_instruction'
  }
  if (
    exitStatus === 126 ||
    /permission denied|failed to map segment from shared object/i.test(output)
  ) {
    return 'noexec'
  }
  if (/\b(?:GLIBC|GLIBCXX|CXXABI)_[0-9.]+'? not found/.test(output)) {
    return 'libc_floor'
  }
  // NixOS's stub loader answers in place of the generic ELF interpreter it does not ship.
  if (exitStatus === 127 && /Could not start dynamically linked executable/.test(output)) {
    return 'wrong_libc'
  }
  // A glibc binary on musl (or the reverse) fails in the ELF interpreter or on relocation.
  if (/ld-linux[\w.-]*\.so|ld-musl[\w.-]*\.so/i.test(output)) {
    return 'wrong_libc'
  }
  // Why before relocation: musl reports each symbol of a missing library as "symbol not found".
  if (
    /error while loading shared libraries|cannot open shared object file|Error loading shared library/i.test(
      output
    )
  ) {
    return 'missing_lib'
  }
  if (/Error relocating|symbol not found/i.test(output)) {
    return 'wrong_libc'
  }
  // The shell's "not found" for a file that exists: its ELF interpreter is absent.
  if (exitStatus === 127 && /no such file or directory|not found/i.test(output)) {
    return 'wrong_libc'
  }
  return null
}

function wrapWithExitReport(command: string): string {
  // Why always exit 0: the exit status is evidence to classify, and execCommand drops stdout on failure.
  return (
    `orca_rt_out=$(${command} 2>&1); orca_rt_status=$?; ` +
    `echo "${REMOTE_NODE_RUNTIME_EXIT_PREFIX}$orca_rt_status"; printf '%s\\n' "$orca_rt_out" | head -c 16000`
  )
}

export function pinnedRuntimeVersionCommand(nodePath: string): string {
  return wrapWithExitReport(`${shellEscape(nodePath)} --version`)
}

export function relayRuntimeSelfTestCommand(
  relayDir: string,
  nodePath: string,
  nonce: string
): string {
  return `cd ${shellEscape(relayDir)} && ${wrapWithExitReport(
    `${shellEscape(nodePath)} relay.js ${RELAY_RUNTIME_SELF_TEST_FLAG} ${shellEscape(nonce)}`
  )}`
}

/**
 * One powershell.exe for the whole Windows self-test: the promote step already ran
 * `node.exe --version`, and the report's `node` field repeats it, so no second spawn.
 */
export function windowsRelayRuntimeSelfTestCommand(
  relayDir: string,
  nodePath: string,
  nonce: string
): string {
  return powerShellCommand(
    [
      `Set-Location -LiteralPath ${powerShellLiteral(relayDir)}`,
      "$out = ''; $status = $null",
      `try { $out = ((& ${powerShellLiteral(nodePath)} 'relay.js' ${powerShellLiteral(RELAY_RUNTIME_SELF_TEST_FLAG)} ${powerShellLiteral(nonce)} 2>&1) | ForEach-Object { "$_" }) -join "\`n"; $status = $LASTEXITCODE } catch { $status = -1; $out = $_.Exception.Message }`,
      `Write-Output (${powerShellLiteral(REMOTE_NODE_RUNTIME_EXIT_PREFIX)} + $status)`,
      'Write-Output ($out.Substring(0, [Math]::Min(16000, $out.Length)))'
    ].join('\n')
  )
}

function readReport(output: string, nonce: string): RelayRuntimeSelfTestReport | null {
  for (const line of output.split('\n')) {
    if (!line.startsWith(RELAY_RUNTIME_SELF_TEST_PREFIX)) {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line.slice(RELAY_RUNTIME_SELF_TEST_PREFIX.length))
      if (
        parsed &&
        typeof parsed === 'object' &&
        'nonce' in parsed &&
        parsed.nonce === nonce &&
        'ok' in parsed &&
        typeof parsed.ok === 'boolean'
      ) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the nonce ties this line to our own relay build, which prints exactly RelayRuntimeSelfTestReport; the ok discriminant is checked above.
        return parsed as RelayRuntimeSelfTestReport
      }
    } catch {
      return null
    }
  }
  return null
}

function refusedOrFailed(
  exitStatus: number | null,
  output: string,
  step: string
): PinnedRuntimeSelfTestVerdict {
  const refusal = classifyPinnedRuntimeFailure(exitStatus, output)
  const detail = `${step} (exit ${exitStatus ?? 'unknown'}): ${output.slice(0, 2000)}`
  return refusal ? { verdict: 'refused', refusal, detail } : { verdict: 'failed', detail }
}

/** Null when the runtime printed the pinned version; otherwise its refusal or failure. */
export function evaluatePinnedRuntimeVersion(
  versionOutput: string
): PinnedRuntimeSelfTestVerdict | null {
  const version = parseRemoteRuntimeExitReport(versionOutput)
  if (version.exitStatus === 0 && version.output === `v${NODE_RUNTIME_PIN.version}`) {
    return null
  }
  return refusedOrFailed(version.exitStatus, version.output, 'node --version')
}

export function evaluateRelayRuntimeSelfTest(
  selfTestOutput: string,
  nonce: string
): PinnedRuntimeSelfTestVerdict {
  const selfTest = parseRemoteRuntimeExitReport(selfTestOutput)
  const report = readReport(selfTest.output, nonce)
  if (report?.ok) {
    return { verdict: 'passed', report }
  }
  if (report && !report.ok && report.stage === 'spawn') {
    // Why never a refusal: the addon loaded, so this runtime and libc are not what failed.
    return { verdict: 'failed', detail: `relay self-test could not open a PTY: ${report.error}` }
  }
  const evidence = report && !report.ok ? report.error : selfTest.output
  return refusedOrFailed(selfTest.exitStatus, evidence, 'relay self-test')
}

/** The Windows run skips the separate `--version` step, so the report must name the pin. */
export function evaluateWindowsRelayRuntimeSelfTest(
  selfTestOutput: string,
  nonce: string
): PinnedRuntimeSelfTestVerdict {
  const verdict = evaluateRelayRuntimeSelfTest(selfTestOutput, nonce)
  if (verdict.verdict === 'passed' && verdict.report.node !== `v${NODE_RUNTIME_PIN.version}`) {
    return {
      verdict: 'failed',
      detail: `relay self-test ran on ${verdict.report.node}, not the pin`
    }
  }
  return verdict
}

export type RelayRuntimeSelfTestOptions = {
  attempts?: number
  host?: RemoteHostPlatform
  /** False on rung C: the host's own Node has no pinned version to match. */
  expectPinnedVersion?: boolean
}

async function runSelfTestOnce(
  conn: SshConnection,
  relayDir: string,
  nodePath: string,
  signal: AbortSignal | undefined,
  options: RelayRuntimeSelfTestOptions
): Promise<PinnedRuntimeSelfTestVerdict> {
  const deadline = Date.now() + RELAY_RUNTIME_SELF_TEST_BUDGET_MS
  const remaining = (): number => Math.max(1_000, deadline - Date.now())
  const nonce = randomBytes(12).toString('hex')
  try {
    if (options.host && isWindowsRemoteHost(options.host)) {
      const output = await execCommand(
        conn,
        windowsRelayRuntimeSelfTestCommand(relayDir, nodePath, nonce),
        { timeoutMs: remaining(), wrapCommand: false, signal }
      )
      return options.expectPinnedVersion === false
        ? evaluateRelayRuntimeSelfTest(output, nonce)
        : evaluateWindowsRelayRuntimeSelfTest(output, nonce)
    }
    const versionVerdict =
      options.expectPinnedVersion === false
        ? null
        : evaluatePinnedRuntimeVersion(
            await execCommand(conn, pinnedRuntimeVersionCommand(nodePath), {
              timeoutMs: remaining(),
              signal
            })
          )
    if (versionVerdict) {
      return versionVerdict
    }
    return evaluateRelayRuntimeSelfTest(
      await execCommand(conn, relayRuntimeSelfTestCommand(relayDir, nodePath, nonce), {
        timeoutMs: remaining(),
        signal
      }),
      nonce
    )
  } catch (error) {
    signal?.throwIfAborted()
    // A timeout, or a channel that failed to open or dropped, answered nothing about the runtime.
    return {
      verdict: 'unverifiable',
      detail: error instanceof Error ? error.message : String(error),
      cause: error
    }
  }
}

/** One retry on `unverifiable`, never on an answered verdict. */
export async function runPinnedRuntimeSelfTest(
  conn: SshConnection,
  relayDir: string,
  nodePath: string,
  signal?: AbortSignal,
  options: RelayRuntimeSelfTestOptions = {}
): Promise<PinnedRuntimeSelfTestVerdict> {
  const attempts = options.attempts ?? 2
  let verdict: PinnedRuntimeSelfTestVerdict = {
    verdict: 'unverifiable',
    detail: 'the self-test never ran'
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    verdict = await runSelfTestOnce(conn, relayDir, nodePath, signal, options)
    if (verdict.verdict !== 'unverifiable') {
      return verdict
    }
    // A command whose teardown is unconfirmed may still hold the host; do not stack another.
    if (isUnconfirmedSshCommandTermination(verdict.cause)) {
      return verdict
    }
  }
  return verdict
}
