import { execFile } from 'node:child_process'
import { posix as pathPosix } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource
} from '../../shared/skills'
import { buildEncodedWslBashCommand, quoteBashString } from '../wsl-bash-command'
import {
  buildSkillDiscoverySources,
  compareSkills,
  sourceKindForSkill,
  sourceLabelForSkill,
  stablePathId,
  type SkillScanRoot
} from './skill-discovery-sources'
import { discoverClaudePluginSkillSourcesInWsl } from './claude-plugin-skill-sources-wsl'

const MAX_MARKDOWN_BYTES = 256 * 1024
const MAX_PACKAGE_FILES = 200
const WSL_SCAN_TIMEOUT_MS = 10_000
const WSL_SCAN_MAX_BUFFER_BYTES = 128 * 1024 * 1024

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
    `    directory_path=\${skill_file%/*}`,
    `    updated_at=$(stat -c '%Y' -- "$skill_file" 2>/dev/null || true)`,
    `    encoded_markdown=$(head -c ${MAX_MARKDOWN_BYTES} -- "$skill_file" 2>/dev/null | base64 | tr -d '\\n') || continue`,
    '    file_count=0',
    `    while IFS= read -r -d '' package_file; do`,
    '      file_count=$((file_count + 1))',
    `      [ "$file_count" -ge ${MAX_PACKAGE_FILES} ] && break`,
    `    done < <(find -L "$directory_path" -type f -print0 2>/dev/null)`,
    `    printf '%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0' S "$root_index" "$skill_file" "$canonical_path" "$updated_at" "$file_count"`,
    `    printf '%s' "$encoded_markdown"`,
    `    printf '\\0'`,
    `  done < <(find -L "$root_path" -mindepth 1 -maxdepth "$max_depth" -type f -name 'SKILL.md' -print0 2>/dev/null)`,
    '}'
  ]
  roots.forEach((root, index) => {
    const maxDepth = root.sourceKind === 'plugin' ? 10 : 5
    lines.push(`scan_root ${index} ${quoteBashString(root.path)} ${maxDepth}`)
  })
  return buildEncodedWslBashCommand(lines.join('\n'))
}

function executeWslSkillDiscovery(distro: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['-d', distro, '--', 'bash', '-c', command],
      {
        encoding: 'utf8',
        maxBuffer: WSL_SCAN_MAX_BUFFER_BYTES,
        timeout: WSL_SCAN_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
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
    const fileCount = Number.parseInt(readProtocolField(fields, index++), 10)
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
      fileCount: Number.isFinite(fileCount) ? fileCount : 0,
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
      pathApi: pathPosix
    }),
    ...pluginRoots
  ]
  // Why: UNC traversal applies Windows casing and symlink rules. The distro
  // must own enumeration, metadata reads, and canonical path identity.
  const output = await executeWslSkillDiscovery(args.distro, buildWslSkillDiscoveryCommand(roots))
  return parseWslSkillDiscoveryOutput(output, roots)
}
