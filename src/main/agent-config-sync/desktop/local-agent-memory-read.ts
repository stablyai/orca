import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  AGENT_CONFIG_MEMORY_NAME,
  AGENT_CONFIG_SELF_PATH,
  type AgentConfigItemKind
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { agentConfigDigest } from '../agent-config-digest'
import type { LocalAgentConfigItem } from './local-agent-config-read'
import { readItemFile } from './agent-config-item-file'

// `@path` imports in CLAUDE.md/AGENTS.md: a word starting with @ that looks like a path.
const IMPORT = /(?:^|\s)@((?:~|\.{1,2})?\/?[^\s@`'")\]]+)/g

/** Imports that point outside the agent's config folder: the sandbox won't have those files. */
export function countLocalMemoryRefs(text: string, root: string): number {
  let count = 0
  for (const match of text.matchAll(IMPORT)) {
    const target = match[1]
    if (!target.includes('/') && !target.includes('.')) {
      // "@alice" is a mention, not a file.
      continue
    }
    const full = target.startsWith('~/')
      ? join(homedir(), target.slice(2))
      : isAbsolute(target)
        ? target
        : resolve(root, target)
    const rel = relative(root, full)
    if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep)[0] === '..') {
      count += 1
    }
  }
  return count
}

/** CLAUDE.md or AGENTS.md as one item; same size and secret rules as a command. */
export async function readMemory(
  root: string,
  kind: AgentConfigItemKind
): Promise<LocalAgentConfigItem[]> {
  const name = AGENT_CONFIG_MEMORY_NAME[kind]
  if (!name) {
    return []
  }
  const path = join(root, `${name}.md`)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    return []
  }
  const base = { scope: 'user' as const, kind, name, withheldFiles: 0, fileCount: 1 }
  const read = await readItemFile(path, `${name}.md`).catch(() => 'invalid' as const)
  if (read === 'too-large' || read === 'invalid' || read === 'withheld') {
    return [
      {
        ...base,
        files: [],
        bytes: info.size,
        digest: null,
        skipReason: read === 'withheld' ? 'secret' : read
      }
    ]
  }
  const files = [{ path: AGENT_CONFIG_SELF_PATH, executable: false, bytes: read.bytes }]
  const localRefs = countLocalMemoryRefs(read.bytes.toString('utf8'), root)
  return [
    {
      ...base,
      files,
      bytes: read.bytes.length,
      digest: agentConfigDigest(files),
      ...(localRefs > 0 ? { localRefs } : {})
    }
  ]
}
