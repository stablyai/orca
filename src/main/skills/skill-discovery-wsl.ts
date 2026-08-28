import { posix as pathPosix } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource
} from '../../shared/skills'
import { quoteBashString } from '../wsl-bash-command'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  buildSkillDiscoverySources,
  compareSkills,
  sourceKindForSkill,
  sourceLabelForSkill,
  stablePathId,
  type SkillScanRoot
} from './skill-discovery-sources'
import { discoverClaudePluginSkillSourcesInWsl } from './claude-plugin-skill-sources-wsl'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import { SKILL_STAGING_GLOB } from './skill-delete/staging-names'
import { skillFileMaxDepth } from '../../shared/skill-discovery-depth'

const MAX_MARKDOWN_BYTES = 256 * 1024
const WSL_SCAN_TIMEOUT_MS = 10_000
const WSL_SCAN_MAX_OUTPUT_BYTES = 128 * 1024 * 1024

export function buildWslSkillDiscoveryCommand(roots: readonly SkillScanRoot[]): string {
  const lines = [
    'set -u',
    'set -o pipefail',
    'scan_root() {',
    '  root_index=$1',
    '  root_path=$2',
    '  max_depth=$3',
    '  if [ ! -d "$root_path" ]; then',
    `    printf '%s\\0%s\\0%s\\0' R "$root_index" 0`,
    '    return',
    '  fi',
    `  printf '%s\\0%s\\0%s\\0' R "$root_index" 1`,
    `  while IFS= read -r -d '' skill_file; do`,
    `    canonical_path=$(realpath -- "$skill_file" 2>/dev/null || printf '%s' "$skill_file")`,
    `    updated_at=$(stat -c '%Y' -- "$skill_file" 2>/dev/null || true)`,
    `    encoded_markdown=$(head -c ${MAX_MARKDOWN_BYTES} -- "$skill_file" 2>/dev/null | base64 | tr -d '\\n') || continue`,
    `    printf '%s\\0%s\\0%s\\0%s\\0%s\\0' S "$root_index" "$skill_file" "$canonical_path" "$updated_at"`,
    `    printf '%s' "$encoded_markdown"`,
    `    printf '\\0'`,
    `  done < <(find -L "$root_path" -mindepth 1 -maxdepth "$max_depth" \\( -name '${SKILL_STAGING_GLOB}' -prune \\) -o \\( -type f -name 'SKILL.md' -print0 \\) 2>/dev/null)`,
    '}'
  ]
  roots.forEach((root, index) => {
    const maxDepth = skillFileMaxDepth(root.sourceKind)
    lines.push(`scan_root ${index} ${quoteBashString(root.path)} ${maxDepth}`)
  })
  return lines.join('\n')
}

async function executeWslSkillDiscovery(distro: string, script: string): Promise<string> {
  // Why bash: the scan uses process substitution (`done < <(find ...)`), which
  // dash rejects with `Syntax error: word unexpected` (#14292).
  const result = await runWslProcess({
    distro,
    // 'none': find/base64/head/printf/stat over $HOME roots, no bare tool.
    loginPath: 'none',
    script,
    shell: 'bash',

    timeoutMs: WSL_SCAN_TIMEOUT_MS,
    maxOutputBytes: WSL_SCAN_MAX_OUTPUT_BYTES
  })
  // Why throw: runWslProcess resolves on a non-zero exit, and an empty stdout
  // parses into a valid "zero skills" result -- which reads as "nothing is
  // installed" and re-offers installs for skills that are present.
  if (result.code !== 0 || result.timedOut) {
    throw new Error('skill-discovery-wsl-scan-failed')
  }
  return result.stdout
}

function readProtocolField(fields: string[], index: number): string {
  const value = fields[index]
  if (value === undefined) {
    throw new Error('WSL skill discovery returned an incomplete response.')
  }
  return value
}

export function parseWslSkillDiscoveryOutput(
  output: string,
  roots: readonly SkillScanRoot[],
  scannedAt = Date.now()
): SkillDiscoveryResult {
  const fields = output.split('\0')
  const rootExists = new Map<number, boolean>()
  const skillsByCanonicalPath = new Map<string, DiscoveredSkill>()
  let index = 0
  while (index < fields.length && fields[index]) {
    const recordKind = fields[index++]
    const rootIndex = Number.parseInt(readProtocolField(fields, index++), 10)
    const root = roots[rootIndex]
    if (!root) {
      throw new Error('WSL skill discovery returned an unknown source.')
    }
    if (recordKind === 'R') {
      rootExists.set(rootIndex, readProtocolField(fields, index++) === '1')
      continue
    }
    if (recordKind !== 'S') {
      throw new Error('WSL skill discovery returned an invalid response.')
    }

    const skillFilePath = readProtocolField(fields, index++)
    const canonicalSkillFilePath = readProtocolField(fields, index++)
    const updatedAtSeconds = Number.parseInt(readProtocolField(fields, index++), 10)
    const markdown = Buffer.from(readProtocolField(fields, index++), 'base64').toString('utf8')
    const existing = skillsByCanonicalPath.get(canonicalSkillFilePath)
    if (existing) {
      // Why: dedup keeps one row, but every contributing root must survive so
      // per-agent visibility does not depend on root scan order. providers is
      // per-agent visibility too, so union it rather than keeping only the first.
      if (existing.rootPaths && !existing.rootPaths.includes(root.path)) {
        existing.rootPaths.push(root.path)
      }
      // Reassign a fresh array — `providers` aliases the scan root's array, so
      // pushing in place would mutate the root and sibling skills/sources.
      const mergedProviders = [...existing.providers]
      for (const provider of root.providers) {
        if (!mergedProviders.includes(provider)) {
          mergedProviders.push(provider)
        }
      }
      existing.providers = mergedProviders
      continue
    }
    const directoryPath = pathPosix.dirname(skillFilePath)
    const summary = summarizeSkillMarkdown(markdown)
    const sourceKind = sourceKindForSkill(root, skillFilePath, pathPosix)
    skillsByCanonicalPath.set(canonicalSkillFilePath, {
      id: stablePathId(canonicalSkillFilePath),
      name: summary.name ?? pathPosix.basename(directoryPath),
      description: summary.description,
      // Copy: `root.providers` is shared across every skill/source from this
      // root, so a later in-place merge must not mutate the aliased array.
      providers: [...root.providers],
      sourceKind,
      sourceLabel: sourceLabelForSkill(root, sourceKind),
      rootPath: root.path,
      rootPaths: [root.path],
      directoryPath,
      skillFilePath,
      installed: true,
      updatedAt: Number.isFinite(updatedAtSeconds) ? updatedAtSeconds * 1000 : null
    })
  }

  const sources: SkillDiscoverySource[] = roots.map((root, rootIndex) => {
    const exists = rootExists.get(rootIndex) ?? false
    return {
      ...root,
      providers: [...root.providers],
      exists,
      skippedReason: exists ? undefined : 'missing'
    }
  })
  return {
    skills: [...skillsByCanonicalPath.values()].sort(compareSkills),
    sources: sources.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    ),
    scannedAt
  }
}

export async function discoverSkillsInWsl(args: {
  distro: string
  homeDir: string
  cwd: string
  providerRootOverrides?: SkillProviderRootOverrides
}): Promise<SkillDiscoveryResult> {
  // Plugin roots are resolved (in JS) from metadata this first wsl.exe call
  // reads, then fed to the scan's own wsl.exe call below — two sequential
  // process boots. That is a deliberate one-time-per-pane cost (the renderer
  // caches per pane); folding both into one invocation would require porting
  // the plugin-install resolution into bash, which is not worth the risk.
  //
  // Why: plugin-metadata enrichment is optional. A failed/timed-out read must
  // degrade to zero plugin roots (matching the native readMetadataFile path),
  // not abort the mandatory native/home/repo/bundled scan.
  let pluginRoots: SkillScanRoot[] = []
  try {
    pluginRoots = await discoverClaudePluginSkillSourcesInWsl(args)
  } catch {
    pluginRoots = []
  }
  const roots = [
    ...buildSkillDiscoverySources({
      homeDir: args.homeDir,
      cwd: args.cwd,
      repos: [],
      pathApi: pathPosix,
      providerRootOverrides: args.providerRootOverrides
    }),
    ...pluginRoots
  ]
  // Why: UNC traversal applies Windows casing and symlink rules. The distro
  // must own enumeration, metadata reads, and canonical path identity.
  const output = await executeWslSkillDiscovery(args.distro, buildWslSkillDiscoveryCommand(roots))
  return parseWslSkillDiscoveryOutput(output, roots)
}
