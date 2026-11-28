import { posix as pathPosix } from 'node:path'
import { summarizeSkillMarkdown } from '../../../shared/skills/discovery/skill-metadata'
import {
  customSlashCommandName,
  dedupeCustomSlashCommands,
  type DiscoveredSlashCommand
} from '../../../shared/skills/discovery/custom-slash-commands'
import { SKILL_FILE_MAX_DEPTH } from '../../../shared/skills/discovery/skill-discovery-depth'
import { quotePosixShell as quoteBashString } from '../../../shared/shell/launch/shell-argument-quoting'
import type { CustomSlashCommandRoot } from './custom-slash-command-discovery'

const MAX_MARKDOWN_BYTES = 256 * 1024

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
    `  done < <(find -L "$root_path" -mindepth 1 -maxdepth ${SKILL_FILE_MAX_DEPTH} -type f -iname '*.md' -print0 2>/dev/null)`,
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
