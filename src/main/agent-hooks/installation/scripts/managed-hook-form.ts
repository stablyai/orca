import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { getSharedManagedScriptPath } from './managed-hook-script-path'

// Every Orca build shares ~/.orca/agent-hooks. Bump this when managed hook bytes change so older builds
// stop overwriting them; newer hooks must stay compatible with older listeners.
export const MANAGED_HOOK_FORM = 1

const FORM_MARKER = /orca-agent-hook-form=(\d+)/
const MARKER_SCAN_BYTES = 512

/** Scripts from before the marker read as form 0. */
export function readManagedHookForm(content: string | Buffer): number {
  const head =
    typeof content === 'string'
      ? content.slice(0, MARKER_SCAN_BYTES)
      : content.subarray(0, MARKER_SCAN_BYTES).toString()
  const marker = FORM_MARKER.exec(head)
  return marker ? Number(marker[1]) : 0
}

export function isFromNewerManagedHookForm(content: string | Buffer): boolean {
  return readManagedHookForm(content) > MANAGED_HOOK_FORM
}

export function withManagedHookForm(scriptPath: string, content: string): string
export function withManagedHookForm(scriptPath: string, content: string | Buffer): string | Buffer
export function withManagedHookForm(scriptPath: string, content: string | Buffer): string | Buffer {
  if (typeof content !== 'string' || FORM_MARKER.test(content)) {
    return content
  }
  const marker = `orca-agent-hook-form=${MANAGED_HOOK_FORM}`
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  switch (extname(scriptPath).toLowerCase()) {
    case '.sh':
      return insertAfterFirstLineIf(content, /^#!/, `# ${marker}`, eol)
    case '.cmd':
    case '.bat':
      // After `@echo off` a bare rem stays silent; before it, @ keeps cmd from echoing the line.
      return /^@echo off/i.test(content)
        ? insertAfterFirstLineIf(content, /^@echo off/i, `rem ${marker}`, eol)
        : `@rem ${marker}${eol}${content}`
    case '.ps1':
      return `# ${marker}${eol}${content}`
    default:
      return content
  }
}

function insertAfterFirstLineIf(
  content: string,
  firstLine: RegExp,
  line: string,
  eol: string
): string {
  if (!firstLine.test(content)) {
    return `${line}${eol}${content}`
  }
  const end = content.indexOf('\n')
  return end === -1
    ? `${content}${eol}${line}`
    : `${content.slice(0, end + 1)}${line}${eol}${content.slice(end + 1)}`
}

/** True when a newer build last wrote any of this agent's shared hook scripts; its config entries go with them. */
export async function isAgentHookOwnedByNewerBuild(agent: string): Promise<boolean> {
  const dir = dirname(getSharedManagedScriptPath(`${agent}-hook.sh`))
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (!name.startsWith(`${agent}-hook.`) && !name.startsWith(`${agent}-hook-`)) {
      continue
    }
    const content = await readFile(join(dir, name)).catch(() => null)
    if (content && isFromNewerManagedHookForm(content)) {
      return true
    }
  }
  return false
}
