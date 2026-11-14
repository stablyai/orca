/** Keep ZCode's hidden transcript messages out of every AI Vault read path. */
export function zcodeVisibleMessageFilter(
  agent: 'opencode' | 'zcode',
  column: 'm.data' | 'data' = 'm.data'
): string {
  return agent === 'zcode'
    ? `AND COALESCE(json_extract(${column}, '$.semantics.transcriptVisibility'), 'visible') != 'hidden'`
    : ''
}
