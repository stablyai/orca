import { posix as pathPosix } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource,
  SkillSourceKind
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
const WSL_SCAN_TIMEOUT_MS = 30_000
const WSL_SCAN_MAX_OUTPUT_BYTES = 128 * 1024 * 1024

function rootMayContainSourceKind(
  root: SkillScanRoot,
  sourceKinds: readonly SkillSourceKind[] | undefined
): boolean {
  if (!sourceKinds) {
    return true
  }
  if (root.sourceKind === 'home') {
    return sourceKinds.includes('home') || sourceKinds.includes('bundled')
  }
  return sourceKinds.includes(root.sourceKind)
}

export function buildWslSkillDiscoveryCommand(
  roots: readonly SkillScanRoot[],
  names?: readonly string[]
): string {
  const normalizedNames = names?.map((name) => name.trim().toLowerCase()).filter(Boolean)
  const nameFilterHelpers: string[] = []
  const nameFilterBody: string[] = []
  if (normalizedNames?.length) {
    const patterns = [...new Set(normalizedNames)].map(quoteBashString).join('|')
    nameFilterHelpers.push(
      'matches_requested_name() {',
      '  local normalized_name=${1,,}',
      '  case "$normalized_name" in',
      `    ${patterns}) return 0 ;;`,
      '    *) return 1 ;;',
      '  esac',
      '}',
      'read_frontmatter_name() {',
      '  metadata_name=',
      '  local line first_line=1',
      '  while IFS= read -r line; do',
      "    line=${line%$'\\r'}",
      '    if [ "$first_line" -eq 1 ]; then',
      '      first_line=0',
      '      [[ "$line" =~ ^---[[:space:]]*$ ]] || return',
      '      continue',
      '    fi',
      '    [[ "$line" =~ ^---[[:space:]]*$ ]] && return',
      '    if [[ "$line" =~ ^[[:space:]]*name[[:space:]]*:[[:space:]]*(.*)$ ]]; then',
      '      metadata_name=${BASH_REMATCH[1]}',
      '      while [[ "$metadata_name" == [[:space:]]* ]]; do metadata_name=${metadata_name#?}; done',
      '      while [[ "$metadata_name" == *[[:space:]] ]]; do metadata_name=${metadata_name%?}; done',
      '      local quote=${metadata_name:0:1}',
      `      if { [ "$quote" = '"' ] || [ "$quote" = "'" ]; } && [ "\${metadata_name: -1}" = "$quote" ]; then`,
      '        metadata_name=${metadata_name:1:${#metadata_name}-2}',
      '      fi',
      '      return',
      '    fi',
      '  done < "$1"',
      '}'
    )
    nameFilterBody.push(
      '    directory_name=${directory_path##*/}',
      '    if ! matches_requested_name "$directory_name"; then',
      '      read_frontmatter_name "$skill_file"',
      '      matches_requested_name "$metadata_name" || continue',
      '    fi'
    )
  }
  const lines = [
    'set -u',
    'set -o pipefail',
    ...nameFilterHelpers,
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
    `    directory_path=\${skill_file%/*}`,
    ...nameFilterBody,
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
  scannedAt = Date.now(),
  sourceKinds?: readonly SkillSourceKind[]
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
    if (sourceKinds && !sourceKinds.includes(sourceKind)) {
      continue
    }
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
  cwd?: string
  names?: string[]
  sourceKinds?: SkillSourceKind[]
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
  if (args.cwd && (!args.sourceKinds || args.sourceKinds.includes('plugin'))) {
    try {
      pluginRoots = await discoverClaudePluginSkillSourcesInWsl({ ...args, cwd: args.cwd })
    } catch {
      pluginRoots = []
    }
  }
  const roots = [
    ...buildSkillDiscoverySources({
      homeDir: args.homeDir,
      cwd: args.cwd,
      repos: [],
      includeCwd: Boolean(args.cwd),
      pathApi: pathPosix,
      providerRootOverrides: args.providerRootOverrides
    }),
    ...pluginRoots
  ].filter((root) => rootMayContainSourceKind(root, args.sourceKinds))
  // Why: UNC traversal applies Windows casing and symlink rules. The distro
  // must own enumeration, metadata reads, and canonical path identity.
  const output = await executeWslSkillDiscovery(
    args.distro,
    buildWslSkillDiscoveryCommand(roots, args.names)
  )
  return parseWslSkillDiscoveryOutput(output, roots, Date.now(), args.sourceKinds)
}
