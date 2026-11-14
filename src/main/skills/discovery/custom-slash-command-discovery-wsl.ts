import { posix as pathPosix } from 'node:path'
import { summarizeSkillMarkdown } from '../../../shared/skill-metadata'
import {
  customSlashCommandName,
  dedupeCustomSlashCommands,
  type DiscoveredSlashCommand
} from '../../../shared/custom-slash-commands'
import { SKILL_FILE_MAX_DEPTH } from '../../../shared/skill-discovery-depth'
import { quotePosixShell as quoteBashString } from '../../../shared/shell/launch/shell-argument-quoting'
import { runWslProcess } from '../../wsl/execution/wsl-runner'
import {
  buildCustomSlashCommandRoots,
  type CustomSlashCommandRoot
} from './custom-slash-command-discovery'

const MAX_MARKDOWN_BYTES = 256 * 1024
const WSL_COMMAND_SCAN_TIMEOUT_MS = 10_000
const WSL_COMMAND_SCAN_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export function buildWslCustomSlashCommandDiscoveryCommand(
  roots: readonly CustomSlashCommandRoot[]
): string {
  const lines = [
    'set -u',
    'set -o pipefail',
    'scan_command_root() {',
    '  root_index=$1',
    '  root_path=$2',
    '  if [ ! -d "$root_path" ]; then',
    '    return',
    '  fi',
    `  while IFS= read -r -d '' command_file; do`,
    `    encoded_markdown=$(head -c ${MAX_MARKDOWN_BYTES} -- "$command_file" 2>/dev/null | base64 | tr -d '\\n') || continue`,
    `    printf '%s\\0%s\\0' "$root_index" "$command_file"`,
    `    printf '%s' "$encoded_markdown"`,
    `    printf '\\0'`,
    `  done < <(find -L "$root_path" -mindepth 1 -maxdepth ${SKILL_FILE_MAX_DEPTH} -type f -name '*.md' -print0 2>/dev/null)`,
    '}'
  ]
  roots.forEach((root, index) => {
    lines.push(`scan_command_root ${index} ${quoteBashString(root.path)}`)
  })
  return lines.join('\n')
}

export function parseWslCustomSlashCommandOutput(
  output: string,
  roots: readonly CustomSlashCommandRoot[]
): DiscoveredSlashCommand[] {
  const fields = output.split('\0')
  const commands: DiscoveredSlashCommand[] = []
  for (let index = 0; index + 2 < fields.length && fields[index]; index += 3) {
    const root = roots[Number.parseInt(fields[index], 10)]
    const commandFilePath = fields[index + 1]
    if (!root) {
      continue
    }
    const name = customSlashCommandName(pathPosix.relative(root.path, commandFilePath))
    if (!name) {
      continue
    }
    const markdown = Buffer.from(fields[index + 2], 'base64').toString('utf8')
    commands.push({
      name,
      description: summarizeSkillMarkdown(markdown).description,
      scope: root.scope,
      commandFilePath
    })
  }
  return dedupeCustomSlashCommands(commands)
}

/** Its own wsl.exe call so a stalled or oversized commands tree degrades to no commands
 *  instead of failing the skill scan that shares the picker. */
export async function discoverCustomSlashCommandsInWsl(args: {
  distro: string
  homeDir: string
  cwd: string
}): Promise<DiscoveredSlashCommand[]> {
  const roots = buildCustomSlashCommandRoots({
    homeDir: args.homeDir,
    cwd: args.cwd,
    pathApi: pathPosix
  })
  try {
    const result = await runWslProcess({
      distro: args.distro,
      loginPath: 'none',
      script: buildWslCustomSlashCommandDiscoveryCommand(roots),
      shell: 'bash',
      timeoutMs: WSL_COMMAND_SCAN_TIMEOUT_MS,
      maxOutputBytes: WSL_COMMAND_SCAN_MAX_OUTPUT_BYTES
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      return []
    }
    return parseWslCustomSlashCommandOutput(result.stdout, roots)
  } catch {
    return []
  }
}
