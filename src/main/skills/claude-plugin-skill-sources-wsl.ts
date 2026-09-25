import { posix as pathPosix } from 'node:path'
import { quoteBashString } from '../wsl-bash-command'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  getClaudePluginMetadataPaths,
  resolveClaudePluginSkillSources,
  type ClaudePluginMetadata
} from './claude-plugin-skill-sources'
import type { SkillScanRoot } from './skill-discovery-sources'

const MAX_PLUGIN_METADATA_BYTES = 4 * 1024 * 1024
const WSL_METADATA_TIMEOUT_MS = 5_000
const WSL_METADATA_MAX_OUTPUT_BYTES = 32 * 1024 * 1024

export function buildWslClaudePluginMetadataCommand(paths: readonly string[]): string {
  const lines = [
    'set -u',
    'set -o pipefail',
    'read_metadata() {',
    '  metadata_index=$1',
    '  metadata_path=$2',
    `  metadata_size=$(stat -c '%s' -- "$metadata_path" 2>/dev/null || true)`,
    `  if [ -z "$metadata_size" ] || [ "$metadata_size" -gt ${MAX_PLUGIN_METADATA_BYTES} ]; then`,
    `    printf '%s\\0%s\\0%s\\0\\0' F "$metadata_index" 0`,
    '    return',
    '  fi',
    `  encoded_metadata=$(base64 < "$metadata_path" | tr -d '\\n') || { printf '%s\\0%s\\0%s\\0\\0' F "$metadata_index" 0; return; }`,
    `  printf '%s\\0%s\\0%s\\0%s\\0' F "$metadata_index" 1 "$encoded_metadata"`,
    '}'
  ]
  paths.forEach((pathValue, index) => {
    lines.push(`read_metadata ${index} ${quoteBashString(pathValue)}`)
  })
  return lines.join('\n')
}

export function parseWslClaudePluginMetadataOutput(
  output: string,
  fileCount: number
): (string | null)[] {
  const contents = Array<string | null>(fileCount).fill(null)
  const fields = output.split('\0')
  let index = 0
  while (index < fields.length && fields[index]) {
    const kind = fields[index++]
    const fileIndex = Number.parseInt(fields[index++] ?? '', 10)
    const exists = fields[index++] === '1'
    const encoded = fields[index++]
    if (kind !== 'F' || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= fileCount) {
      throw new Error('WSL Claude plugin metadata returned an invalid response.')
    }
    if (exists && encoded !== undefined) {
      contents[fileIndex] = Buffer.from(encoded, 'base64').toString('utf8')
    }
  }
  return contents
}

async function executeWslMetadataRead(distro: string, script: string): Promise<string> {
  // Why bash: this payload was authored for bash, and the migration must not
  // quietly change its interpreter.
  const result = await runWslProcess({
    distro,
    // 'none': base64/printf/stat over $HOME paths. The probe would spend up
    // to 4s of a 5s budget before the read of a file up to 4MB begins.
    loginPath: 'none',
    script,
    shell: 'bash',

    timeoutMs: WSL_METADATA_TIMEOUT_MS,
    maxOutputBytes: WSL_METADATA_MAX_OUTPUT_BYTES
  })
  // Truncated-but-well-formed output would otherwise parse as real metadata.
  if (result.code !== 0 || result.timedOut) {
    throw new Error('claude-plugin-skill-sources-wsl-read-failed')
  }
  return result.stdout
}

export async function discoverClaudePluginSkillSourcesInWsl(args: {
  distro: string
  homeDir: string
  cwd: string
}): Promise<SkillScanRoot[]> {
  const paths = getClaudePluginMetadataPaths(args.homeDir, args.cwd, pathPosix)
  const orderedPaths = [paths.installedPlugins, ...paths.settings]
  // Why: plugin enablement and install paths belong to the distro just like
  // SKILL.md identity; reading them through UNC could apply Windows semantics.
  const output = await executeWslMetadataRead(
    args.distro,
    buildWslClaudePluginMetadataCommand(orderedPaths)
  )
  const [installedPlugins, ...settings] = parseWslClaudePluginMetadataOutput(
    output,
    orderedPaths.length
  )
  const metadata: ClaudePluginMetadata = { installedPlugins, settings }
  return resolveClaudePluginSkillSources({ metadata, cwd: args.cwd, pathApi: pathPosix })
}
