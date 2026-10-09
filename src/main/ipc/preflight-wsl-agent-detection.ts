import path from 'node:path'
import { buildPosixFallbackPathPrelude } from '../../shared/posix-version-manager-bin-dirs'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import { classifyOpenCodeCliGeneration } from '../../shared/opencode-cli-generation'
import type { OpenCodeCliGeneration } from '../../shared/opencode-cli-generation'
import { runWslProcess } from '../wsl/wsl-runner'

const WSL_AGENT_DETECTION_TIMEOUT_MS = 10000
const WSL_OPENCODE_VERSION_TIMEOUT_MS = 5000
const WSL_AGENT_DETECTION_PREFIX = '__ORCA_AGENT_PATH__'

export type WslPreflightTarget = {
  distro?: string
}

export async function detectWslCommandsOnPath(
  wslTarget: WslPreflightTarget,
  commands: readonly string[]
): Promise<Set<string>> {
  const uniqueCommands = [...new Set(commands.filter(Boolean))]
  if (uniqueCommands.length === 0) {
    return new Set()
  }

  const commandList = uniqueCommands.map(shellQuote).join(' ')
  const lookupScript = buildPosixCommandPathLookupScript(
    { kind: 'shell-variable', name: 'cmd' },
    // Skip Windows mounts DURING the walk, not after it: WSL appends the
    // Windows PATH, so a Windows `claude` can shadow a real guest install, and
    // discarding the result afterwards reports "not installed" for a user who
    // has both -- the #9725 population the fallback dirs exist to serve.
    { skipWindowsMountDirs: true }
  )
  // Newlines keep the loop valid in every POSIX shell used here.
  const script = [
    // The same fallback the preflight command runner uses: append the
    // version-manager dirs to PATH and let the ordinary lookup find them. A
    // second bespoke `[ -x ]` walk here duplicated the lookup script's own
    // `! -d` guard, which is how a directory once read as an installed CLI.
    buildPosixFallbackPathPrelude(),
    `for cmd in ${commandList}; do`,
    lookupScript,
    'if [ -n "$resolved" ]; then',
    `printf '${WSL_AGENT_DETECTION_PREFIX}%s\\t%s\\n' "$cmd" "$resolved";`,
    'fi',
    'done'
  ].join('\n')

  try {
    // Why probe: the cached login PATH gives the user's real nvm/mise/asdf PATH
    // with no shell in the loop, so there is no rc/motd banner to land in stdout.
    const result = await runWslProcess({
      distro: wslTarget.distro,
      loginPath: 'preferred',
      script,
      // POSIX `command -v` loop; declared because the payload is opaque here.
      shell: 'sh',
      timeoutMs: WSL_AGENT_DETECTION_TIMEOUT_MS
    })
    // runProcess resolves on a timeout and on a non-zero exit, so partial
    // stdout would otherwise read as a complete answer.
    if (result.timedOut || result.code !== 0) {
      return new Set()
    }
    return parseWslDetectedCommands(result.stdout)
  } catch {
    return new Set()
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Classify the opencode generation installed in the WSL guest.
 *
 * Unlike the name-only walk above, this probes the guest binary's `--version`
 * because the guest's install mechanism (npm/pnpm shims, a real POSIX binary)
 * determines whether the v2 `opencode`/`opencode2` pair both resolve, and only
 * the version output tells v1 from v2 (#24987). Bounded and failure-safe: a
 * timeout or non-zero exit returns null, which the caller treats as unknown.
 *
 * The probe resolves the SAME guest binary the name walk selected by reusing
 * the walk's mount-skipping lookup, then executes that resolved path. A bare
 * `command -v opencode` would instead resolve through WSL's appended Windows
 * PATH, so a Windows-mounted `opencode` could shadow the guest install, and the
 * probe would classify the Windows binary while the walk found the guest one --
 * reporting the wrong generation for the guest (#24987 review).
 */
export async function detectWslOpenCodeCliGeneration(
  wslTarget: WslPreflightTarget
): Promise<OpenCodeCliGeneration | null> {
  // Same rule as the name walk: skip Windows-mounted PATH components mid-walk,
  // so the Windows PATH WSL appends cannot shadow the genuine guest install.
  const lookupOptions = { skipWindowsMountDirs: true }
  const resolveOpenCode = buildPosixCommandPathLookupScript(
    { kind: 'literal', value: 'opencode' },
    lookupOptions
  )
  const resolveOpenCode2 = buildPosixCommandPathLookupScript(
    { kind: 'literal', value: 'opencode2' },
    lookupOptions
  )
  const script = [
    buildPosixFallbackPathPrelude(),
    // v1 exposes only `opencode`; v2 exposes both, so `opencode` answers the
    // generation whenever it resolves. Each lookup resets `$resolved` first.
    resolveOpenCode,
    'if [ -z "$resolved" ]; then',
    resolveOpenCode2,
    'fi',
    'if [ -n "$resolved" ]; then',
    '  "$resolved" --version 2>/dev/null',
    'fi'
  ].join('\n')
  try {
    const result = await runWslProcess({
      distro: wslTarget.distro,
      loginPath: 'preferred',
      script,
      shell: 'sh',
      timeoutMs: WSL_OPENCODE_VERSION_TIMEOUT_MS
    })
    if (result.timedOut || result.code !== 0) {
      return null
    }
    return classifyOpenCodeCliGeneration(result.stdout)
  } catch {
    return null
  }
}

function parseWslDetectedCommands(stdout: string): Set<string> {
  const found = new Set<string>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith(WSL_AGENT_DETECTION_PREFIX)) {
      continue
    }
    const payload = line.slice(WSL_AGENT_DETECTION_PREFIX.length)
    const separatorIndex = payload.indexOf('\t')
    if (separatorIndex <= 0) {
      continue
    }
    const command = payload.slice(0, separatorIndex)
    const resolvedPath = payload.slice(separatorIndex + 1)
    // Why: a real guest executable always resolves to a POSIX-absolute path, so
    // a Windows-style C:\ path here is spoofed/non-guest output, not an install.
    if (path.posix.isAbsolute(resolvedPath)) {
      found.add(command)
    }
  }
  return found
}
