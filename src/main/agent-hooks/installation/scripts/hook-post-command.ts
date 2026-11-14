import type { AgentHookSource } from '../../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { ORCA_HOOK_RAW_JSON_TRANSPORT } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { AGENT_HOOK_METADATA_CACHE_DIR } from '../../../../shared/agent-hook-listener/transport/agent-hook-spool'

// Older curl needs C numeric parsing; keep the parent script's UTF-8 locale unchanged.
export function posixCurlCommand(curlCommand = 'curl'): string {
  return `LC_ALL= LC_NUMERIC=C ${curlCommand}`
}

const PACK_HOOK_METADATA = `printf '%s\\037%s\\037%s\\037%s\\037%s\\037%s' "$ORCA_PANE_KEY" "$ORCA_TAB_ID" "$ORCA_AGENT_LAUNCH_TOKEN" "$ORCA_WORKTREE_ID" "$ORCA_AGENT_HOOK_ENV" "$ORCA_AGENT_HOOK_VERSION" | base64 | tr -d '\\n'`

/** Defines `orca_hook_pack_metadata`, which reuses a pane's packed header while every input matches. */
export function buildPosixHookMetadataCacheLines(): string[] {
  return [
    'orca_hook_pack_metadata() {',
    // Length prefixes keep different inputs from forming the same key.
    '  orca_hook_meta_key="${#ORCA_PANE_KEY}:$ORCA_PANE_KEY ${#ORCA_TAB_ID}:$ORCA_TAB_ID ${#ORCA_AGENT_LAUNCH_TOKEN}:$ORCA_AGENT_LAUNCH_TOKEN ${#ORCA_WORKTREE_ID}:$ORCA_WORKTREE_ID ${#ORCA_AGENT_HOOK_ENV}:$ORCA_AGENT_HOOK_ENV ${#ORCA_AGENT_HOOK_VERSION}:$ORCA_AGENT_HOOK_VERSION"',
    '  orca_hook_meta_file=',
    // A stale variable must not create state for an absent Orca installation.
    '  if [ -r "${ORCA_AGENT_HOOK_ENDPOINT:-}" ]; then',
    '    orca_hook_meta_id=$ORCA_PANE_KEY',
    // Name it like the spool file, which may sit on a Windows drive under WSL.
    '    while :; do case "$orca_hook_meta_id" in *[/:]*) orca_hook_meta_id="${orca_hook_meta_id%%[/:]*}_${orca_hook_meta_id#*[/:]}" ;; *) break ;; esac; done',
    `    orca_hook_meta_file="\${ORCA_AGENT_HOOK_ENDPOINT%/*}/${AGENT_HOOK_METADATA_CACHE_DIR}/pane-$orca_hook_meta_id"`,
    '    orca_hook_meta_line=',
    '    IFS= read -r orca_hook_meta_line 2>/dev/null < "$orca_hook_meta_file"',
    '    orca_hook_metadata=${orca_hook_meta_line%% *}',
    '    [ -z "$orca_hook_metadata" ] || [ "${orca_hook_meta_line#* }" != "$orca_hook_meta_key" ] || return 0',
    '  fi',
    `  orca_hook_metadata=$(${PACK_HOOK_METADATA}) && [ -n "$orca_hook_metadata" ] || return 1`,
    '  [ -n "$orca_hook_meta_file" ] || return 0',
    '  [ -d "${orca_hook_meta_file%/*}" ] || mkdir -m 700 "${orca_hook_meta_file%/*}" 2>/dev/null || return 0',
    // Rename so a concurrent event never reads half a line.
    `  printf '%s %s\\n' "$orca_hook_metadata" "$orca_hook_meta_key" 2>/dev/null > "$orca_hook_meta_file.$$" && mv -f "$orca_hook_meta_file.$$" "$orca_hook_meta_file" 2>/dev/null`,
    '  return 0',
    '}'
  ]
}

type PosixAgentHookPostOptions = {
  curlCommand?: string
  indent?: string
  decisionHeaderVar?: string
  /** Take the header from `buildPosixHookMetadataCacheLines` instead of packing it every event. */
  cachedMetadata?: boolean
}

export function buildPosixAgentHookPostCommand(
  source: AgentHookSource,
  options: PosixAgentHookPostOptions = {}
): string[] {
  const curlCommand = posixCurlCommand(options.curlCommand ?? 'curl')
  const indent = options.indent ?? '  '
  // Only Claude's capture sets this; the host checks the attachment itself before trusting it.
  const tmux = source === 'claude'
  // Names the decision format the script prints; absent, Orca never waits on plugins.
  const decision = options.decisionHeaderVar
    ? [`  ${indent}-H "X-Orca-Hook-Decision: \${${options.decisionHeaderVar}:-}" \\`]
    : []
  const url = `"http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/${source}"`
  const packMetadata = options.cachedMetadata
    ? ['  orca_hook_pack_metadata && \\']
    : [
        `  orca_hook_metadata=$(${PACK_HOOK_METADATA}) && \\`,
        '  [ -n "$orca_hook_metadata" ] && \\'
      ]
  return [
    `if [ "\${ORCA_AGENT_HOOK_TRANSPORT:-}" = "${ORCA_HOOK_RAW_JSON_TRANSPORT}" ] && command -v base64 >/dev/null 2>&1 && command -v tr >/dev/null 2>&1; then`,
    ...packMetadata,
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST ${url} \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/json" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Meta-Encoding: base64" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Meta: \${orca_hook_metadata}" \\`,
    `  ${indent}-H "X-Orca-Agent-Process: \${orca_agent_process:-}" \\`,
    ...(tmux ? [`  ${indent}-H "X-Orca-Tmux-Pane: \${orca_tmux_pane:-}" \\`] : []),
    ...decision,
    `  ${indent}--data-binary @-`,
    'else',
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST ${url} \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/x-www-form-urlencoded" \\`,
    `  ${indent}-H "X-Orca-Agent-Hook-Token: \${ORCA_AGENT_HOOK_TOKEN}" \\`,
    ...decision,
    `  ${indent}--data-urlencode "paneKey=\${ORCA_PANE_KEY}" \\`,
    `  ${indent}--data-urlencode "tabId=\${ORCA_TAB_ID}" \\`,
    `  ${indent}--data-urlencode "launchToken=\${ORCA_AGENT_LAUNCH_TOKEN}" \\`,
    `  ${indent}--data-urlencode "worktreeId=\${ORCA_WORKTREE_ID}" \\`,
    `  ${indent}--data-urlencode "env=\${ORCA_AGENT_HOOK_ENV}" \\`,
    `  ${indent}--data-urlencode "version=\${ORCA_AGENT_HOOK_VERSION}" \\`,
    `  ${indent}--data-urlencode "agentProcess=\${orca_agent_process:-}" \\`,
    ...(tmux ? [`  ${indent}--data-urlencode "tmuxPane=\${orca_tmux_pane:-}" \\`] : []),
    `  ${indent}--data-urlencode "payload@-"`,
    'fi'
  ]
}
