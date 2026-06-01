import { execFile } from 'child_process'
import { promisify } from 'util'
import { getSpawnArgsForWindows } from '../win32-utils'

const execFileAsync = promisify(execFile)

export type LanguageServerCommand = {
  command: string
  args: string[]
}

type LanguageServerDiscoveryResult =
  | { ok: true; command: LanguageServerCommand }
  | { ok: false; reason: string }

type LanguageServerCandidate = LanguageServerCommand & {
  detectCommand?: string
  probeArgs?: string[]
  requiredHelpText?: string
  unavailableReason?: string
}

const COMMAND_DISCOVERY_TTL_MS = 30_000
const FAILED_COMMAND_DISCOVERY_TTL_MS = 1_000

const LANGUAGE_SERVER_CANDIDATES: Record<string, LanguageServerCandidate[]> = {
  rust: [{ command: 'rust-analyzer', args: [], probeArgs: ['--version'] }],
  c: [{ command: 'clangd', args: [], probeArgs: ['--version'] }],
  cpp: [{ command: 'clangd', args: [], probeArgs: ['--version'] }],
  go: [{ command: 'gopls', args: [], probeArgs: ['version'] }],
  python: [{ command: 'pyright-langserver', args: ['--stdio'], probeArgs: ['--version'] }],
  typescript: [
    {
      command: 'tsgo',
      args: ['--lsp'],
      probeArgs: ['--help', '--all'],
      requiredHelpText: '--lsp',
      unavailableReason:
        'native TypeScript Go is installed, but this build does not expose LSP mode'
    }
  ],
  javascript: [
    {
      command: 'tsgo',
      args: ['--lsp'],
      probeArgs: ['--help', '--all'],
      requiredHelpText: '--lsp',
      unavailableReason:
        'native TypeScript Go is installed, but this build does not expose LSP mode'
    }
  ]
}

type CachedDiscovery =
  | { expiresAt: number; command: LanguageServerCommand }
  | { expiresAt: number; reason: string }

const discoveryCache = new Map<string, CachedDiscovery>()
const discoveryInFlight = new Map<string, Promise<LanguageServerDiscoveryResult>>()

function finderCommand(): { command: string; argsFor: (candidate: string) => string[] } {
  if (process.platform === 'win32') {
    return { command: 'where', argsFor: (candidate) => [candidate] }
  }
  return { command: 'which', argsFor: (candidate) => [candidate] }
}

async function findCommandPath(command: string): Promise<string | null> {
  const finder = finderCommand()
  try {
    const { stdout } = await execFileAsync(finder.command, finder.argsFor(command), {
      encoding: 'utf-8',
      timeout: 2_000
    })
    return (
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? null
    )
  } catch {
    return null
  }
}

async function candidatePassesProbe(
  candidate: LanguageServerCandidate,
  commandPath: string
): Promise<boolean> {
  if (!candidate.probeArgs) {
    return true
  }
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(commandPath, candidate.probeArgs)
  try {
    const { stdout, stderr } = await execFileAsync(spawnCmd, spawnArgs, {
      encoding: 'utf-8',
      timeout: 3_000
    })
    if (!candidate.requiredHelpText) {
      return true
    }
    return `${stdout}\n${stderr}`.includes(candidate.requiredHelpText)
  } catch {
    return false
  }
}

export function supportedLspLanguages(): string[] {
  return Object.keys(LANGUAGE_SERVER_CANDIDATES)
}

export function resetLanguageServerDiscoveryCache(): void {
  discoveryCache.clear()
  discoveryInFlight.clear()
}

async function discoverLanguageServerCommand(
  cacheKey: string,
  candidates: LanguageServerCandidate[]
): Promise<LanguageServerDiscoveryResult> {
  let installedButRejectedReason: string | null = null
  for (const candidate of candidates) {
    const detectCommand = candidate.detectCommand ?? candidate.command
    const detectedCommandPath = await findCommandPath(detectCommand)
    if (!detectedCommandPath) {
      continue
    }
    const commandPath =
      detectCommand === candidate.command
        ? detectedCommandPath
        : ((await findCommandPath(candidate.command)) ?? candidate.command)
    if (!(await candidatePassesProbe(candidate, commandPath))) {
      installedButRejectedReason =
        candidate.unavailableReason ??
        `${candidate.command} is installed but failed capability probing`
      continue
    }
    const command = { command: commandPath, args: candidate.args }
    discoveryCache.set(cacheKey, { expiresAt: Date.now() + COMMAND_DISCOVERY_TTL_MS, command })
    return { ok: true, command }
  }

  const reason =
    installedButRejectedReason ??
    `install one of: ${candidates.map((candidate) => candidate.command).join(', ')}`
  // Why: the renderer retries unavailable LSP activation after a short delay.
  // Keep failed probes below that cooldown so installs are picked up quickly.
  discoveryCache.set(cacheKey, { expiresAt: Date.now() + FAILED_COMMAND_DISCOVERY_TTL_MS, reason })
  return { ok: false, reason }
}

export async function resolveLanguageServerCommand(
  languageId: string
): Promise<LanguageServerDiscoveryResult> {
  const candidates = LANGUAGE_SERVER_CANDIDATES[languageId]
  if (!candidates) {
    return { ok: false, reason: `no built-in LSP server is configured for ${languageId}` }
  }

  const cacheKey = `${process.platform}:${process.env.PATH ?? ''}:${languageId}`
  const cached = discoveryCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    if ('command' in cached) {
      return { ok: true, command: cached.command }
    }
    return { ok: false, reason: cached.reason }
  }

  const inFlight = discoveryInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  // Why: opening several same-language files can race before the TTL cache is
  // populated. Share the probe so startup does not multiply `which`/`--version`
  // subprocesses by visible panes.
  const discovery = discoverLanguageServerCommand(cacheKey, candidates)
  discoveryInFlight.set(cacheKey, discovery)
  try {
    return await discovery
  } finally {
    if (discoveryInFlight.get(cacheKey) === discovery) {
      discoveryInFlight.delete(cacheKey)
    }
  }
}
